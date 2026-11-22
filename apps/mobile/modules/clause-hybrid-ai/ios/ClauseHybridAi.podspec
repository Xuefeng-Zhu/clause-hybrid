Pod::Spec.new do |s|
  s.name           = 'ClauseHybridAi'
  s.version        = '0.1.0'
  s.summary        = 'Clause Hybrid AI native module (Firebase AI Logic cloud + on-device Gemini Nano / Apple Foundation Models)'
  s.description    = 'Local Expo module bridging Firebase AI Logic hybrid on-device + cloud inference.'
  s.author         = 'Clause'
  s.homepage       = 'https://github.com/clause/clause-hybrid'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'FirebaseCore', '~> 12.19'
  s.dependency 'FirebaseAppCheck', '~> 12.19'
  s.dependency 'FirebaseAILogic', '~> 12.19'
  # Apple Foundation Models ships with iOS 26; weak-link so the app still launches on older iOS.
  s.weak_frameworks = 'FoundationModels'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
