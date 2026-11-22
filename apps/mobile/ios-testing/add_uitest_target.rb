# Adds a ClausePrivateUITests UI-test target to the prebuilt Expo iOS project and
# wires it into the app scheme's Test action. Run after `expo prebuild -p ios`.
# Usage: ruby ios-testing/add_uitest_target.rb ios/ClausePrivate.xcodeproj ClausePrivate
require 'xcodeproj'
require 'fileutils'

project_path = ARGV[0] || 'ios/ClausePrivate.xcodeproj'
app_name = ARGV[1] || 'ClausePrivate'
test_name = "#{app_name}UITests"
src_dir = File.join(__dir__, 'ClausePrivateUITests')
ios_dir = File.dirname(project_path)

project = Xcodeproj::Project.open(project_path)
app_target = project.targets.find { |t| t.name == app_name } or abort("no target #{app_name}")
abort("#{test_name} already exists") if project.targets.any? { |t| t.name == test_name }

dest = File.join(ios_dir, test_name)
FileUtils.mkdir_p(dest)
FileUtils.cp(Dir[File.join(src_dir, '*.swift')], dest)

deployment = app_target.build_configurations.first.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '15.1'
target = project.new_target(:ui_test_bundle, test_name, :ios, deployment)
group = project.main_group.new_group(test_name, test_name)
refs = Dir[File.join(dest, '*.swift')].map { |f| group.new_reference(File.basename(f)) }
target.add_file_references(refs)
target.add_dependency(app_target)

target.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.clausehybrid.app.uitests'
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['TEST_TARGET_NAME'] = app_name
  s['GENERATE_INFOPLIST_FILE'] = 'YES'
  s['SWIFT_VERSION'] = '5.0'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = deployment
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['ENABLE_TESTING_SEARCH_PATHS'] = 'YES'
end
project.save

scheme_path = File.join(project_path, 'xcshareddata', 'xcschemes', "#{app_name}.xcscheme")
scheme = File.exist?(scheme_path) ? Xcodeproj::XCScheme.new(scheme_path) : Xcodeproj::XCScheme.new
scheme.add_build_target(app_target) unless File.exist?(scheme_path)
scheme.add_test_target(target)
scheme.save_as(project_path, app_name, true)
puts "Added #{test_name} (deployment #{deployment}) to #{project_path}"
