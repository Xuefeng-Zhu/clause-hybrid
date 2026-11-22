#!/usr/bin/env python3
"""Inject Firebase config + App Check debug token into the unsigned CI build, re-sign ad-hoc,
and repackage for Firebase Test Lab. Nothing here is committed with the secret values.

usage: prepare_testlab.py <ios-xctest.zip> <GoogleService-Info.plist> <debug-token> <outdir>
"""
import glob, os, plistlib, shutil, subprocess, sys, zipfile

RCODESIGN = os.environ.get("RCODESIGN", "rcodesign")  # github.com/indygreg/apple-platform-rs

src_zip, gsi, token, out = sys.argv[1:5]
work = os.path.join(out, "x")
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)
subprocess.check_call(["unzip", "-q", src_zip, "-d", work])

prod = os.path.join(work, "Release-iphoneos")
apps = [a for a in glob.glob(os.path.join(prod, "*.app")) if not a.endswith("-Runner.app")]
assert len(apps) == 1, apps
app = apps[0]
shutil.copy(gsi, os.path.join(app, "GoogleService-Info.plist"))
ip = os.path.join(app, "Info.plist")
with open(ip, "rb") as f:
    info = plistlib.load(f)
info["ClauseAppCheckDebug"] = True
info["ClauseAppCheckDebugToken"] = token
with open(ip, "wb") as f:
    plistlib.dump(info, f, fmt=plistlib.FMT_BINARY)

for xr in glob.glob(os.path.join(work, "*.xctestrun")):
    with open(xr, "rb") as f:
        d = plistlib.load(f)
    targets = []
    for cfg in d.get("TestConfigurations", []):
        targets += cfg.get("TestTargets", [])
    for k, v in d.items():
        if isinstance(v, dict) and "TestBundlePath" in v:
            targets.append(v)
    for t in targets:
        # Xcode 26.x injects its performance antipattern checker (libRPAC.dylib), which older
        # iOS versions lack; drop it so the runner/app also launch on iOS 18.
        for key in ("EnvironmentVariables", "TestingEnvironmentVariables"):
            envd = t.get(key, {})
            for k in list(envd):
                if k == "DYLD_INSERT_LIBRARIES" or k.startswith("PERFC_"):
                    del envd[k]
        t["UITargetAppPerformanceAntipatternCheckerEnabled"] = False
        t["UserAttachmentLifetime"] = "keepAlways"
        t.setdefault("EnvironmentVariables", {})["FIRAAppCheckDebugToken"] = token
        t.setdefault("UITargetAppEnvironmentVariables", {})["FIRAAppCheckDebugToken"] = token
    with open(xr, "wb") as f:
        plistlib.dump(d, f)
    print("patched", os.path.basename(xr), len(targets), "targets")

# Only the app bundle was modified; the UI-test runner keeps its CI ad-hoc signature.
r = subprocess.run([RCODESIGN, "sign", app], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout[-3000:], r.stderr[-3000:])
    raise SystemExit("rcodesign failed")
print("re-signed (ad-hoc)", os.path.basename(app))
# Ship only the bundles the .xctestrun references.
for entry in os.listdir(prod):
    if not entry.endswith(".app"):
        p = os.path.join(prod, entry)
        shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)

xz = os.path.join(out, "ios-xctest-testlab.zip")
if os.path.exists(xz):
    os.remove(xz)
names = ["Release-iphoneos"] + [os.path.basename(x) for x in glob.glob(os.path.join(work, "*.xctestrun"))]
subprocess.check_call(["zip", "-qry", os.path.abspath(xz)] + names, cwd=work)

ipa = os.path.join(out, "ClausePrivate-testlab.ipa")
pay = os.path.join(out, "ipa", "Payload")
shutil.rmtree(os.path.join(out, "ipa"), ignore_errors=True)
os.makedirs(pay)
shutil.copytree(app, os.path.join(pay, os.path.basename(app)), symlinks=True)
if os.path.exists(ipa):
    os.remove(ipa)
subprocess.check_call(["zip", "-qry", os.path.abspath(ipa), "Payload"], cwd=os.path.join(out, "ipa"))
print(xz, ipa)
