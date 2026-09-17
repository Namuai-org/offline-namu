#!/usr/bin/env ruby
# Reproducible configuration of ios/Namu.xcodeproj (STK-004, DEV-001, DEV-006,
# SIG-001, SEC-007). Idempotent: run it again after adding native sources or
# tests. It never touches CocoaPods-owned phases or settings.
#
#   GEM_HOME=/usr/local/Cellar/cocoapods/<version>/libexec \
#     /usr/local/opt/ruby/bin/ruby ios/scripts/configure_project.rb
#   (or simply: ios/scripts/configure_project.sh)
#
# Run `pod install` afterwards so the NamuTests target receives its xcconfig.
require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'Namu.xcodeproj')
DEPLOYMENT_TARGET = '17.0'
APP_TARGET = 'Namu'
TEST_TARGET = 'NamuTests'
# Matches the BlueprintIdentifier the template scheme already references.
TEST_TARGET_UUID = '00E356ED1AD99517003FC87E'

FONTS = %w[
  DMSans-Regular.ttf
  DMSans-Medium.ttf
  DMSans-SemiBold.ttf
  MaterialSymbolsRounded-Subset.ttf
].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)
app = project.targets.find { |t| t.name == APP_TARGET } or abort("target #{APP_TARGET} missing")

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def ensure_group(parent, name, path)
  parent.children.find { |c| c.isa == 'PBXGroup' && c.display_name == name } ||
    parent.new_group(name, path)
end

def ensure_file(group, path, source_tree = '<group>')
  existing = group.files.find { |f| f.path == path }
  return existing if existing
  ref = group.new_reference(path)
  ref.source_tree = source_tree
  ref
end

def in_phase?(phase, ref)
  phase.files_references.include?(ref)
end

def ensure_script_phase(target, name, script, inputs: [], outputs: [], before: nil)
  phase = target.shell_script_build_phases.find { |p| p.name == name }
  unless phase
    phase = target.new_shell_script_build_phase(name)
    if before
      anchor = target.build_phases.find { |p| p.respond_to?(:name) && p.name == before }
      if anchor
        target.build_phases.delete(phase)
        target.build_phases.insert(target.build_phases.index(anchor), phase)
      end
    end
  end
  phase.shell_path = '/bin/sh'
  phase.shell_script = script
  phase.input_paths = inputs
  phase.output_paths = outputs
  phase.show_env_vars_in_log = '0'
  # These guards must run on every build; they are cheap.
  phase.always_out_of_date = '1'
  phase
end

# ---------------------------------------------------------------------------
# project-level settings
# ---------------------------------------------------------------------------
project.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
end

# ---------------------------------------------------------------------------
# app target settings
# ---------------------------------------------------------------------------
app.build_configurations.each do |config|
  s = config.build_settings
  debug = config.name == 'Debug'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
  # STK-004: internal builds carry the .internal suffix.
  s['PRODUCT_BUNDLE_IDENTIFIER'] = debug ? 'org.namuai.offline.internal' : 'org.namuai.offline'
  s['PRODUCT_NAME'] = 'Namu'
  s['SWIFT_VERSION'] = '5.0'
  s['DEFINES_MODULE'] = 'YES'
  s['SWIFT_OBJC_INTERFACE_HEADER_NAME'] = 'Namu-Swift.h'
  if debug
    # Contract §1: internal builds may use the local fault server.
    s['NAMU_MODEL_ORIGIN'] = 'http://localhost:8787'
    s['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG'
    # Opt-in only: lets a physical device reach Metro on the LAN.
    s['NAMU_DEBUG_ALLOW_LOCAL_NETWORKING'] = 'NO'
  else
    # Release: NAMU_MODEL_ORIGIN must be supplied by the release environment
    # (xcodebuild NAMU_MODEL_ORIGIN=https://… or an xcconfig). The
    # "Namu release guards" phase fails the build when it is not https.
    s.delete('NAMU_MODEL_ORIGIN')
  end
end

# ---------------------------------------------------------------------------
# groups and files
# ---------------------------------------------------------------------------
namu_group = project.main_group.children.find { |c| c.display_name == 'Namu' } or abort('Namu group missing')

native_group = ensure_group(namu_group, 'Native', 'Namu/Native')
Dir.glob(File.join(IOS_DIR, 'Namu/Native/*.{swift,mm,m,h}')).sort.each do |file|
  ref = ensure_file(native_group, File.basename(file))
  next if file.end_with?('.h')
  app.source_build_phase.add_file_reference(ref, true) unless in_phase?(app.source_build_phase, ref)
end

# Privacy manifest must ship in the bundle.
privacy = namu_group.files.find { |f| f.display_name == 'PrivacyInfo.xcprivacy' }
if privacy && !in_phase?(app.resources_build_phase, privacy)
  app.resources_build_phase.add_file_reference(privacy, true)
end

# DS-001 / DS-003: fonts are bundled by reference from src/design/fonts.
fonts_group = ensure_group(namu_group, 'Fonts', '../src/design/fonts')
FONTS.each do |font|
  abort("missing font #{font}") unless File.exist?(File.join(IOS_DIR, '../src/design/fonts', font))
  ref = ensure_file(fonts_group, font)
  app.resources_build_phase.add_file_reference(ref, true) unless in_phase?(app.resources_build_phase, ref)
end

# ---------------------------------------------------------------------------
# script phases (scripts live in ios/scripts so they are reviewable)
# ---------------------------------------------------------------------------
ensure_script_phase(
  app, 'Namu release guards',
  "\"${SRCROOT}/scripts/release_guards.sh\"\n",
  before: 'Bundle React Native code and images'
)
ensure_script_phase(
  app, 'Namu copy trust config',
  "\"${SRCROOT}/scripts/copy_trust_config.sh\"\n",
  before: 'Bundle React Native code and images'
)
# Declaring the processed Info.plist as an input orders this phase after
# ProcessInfoPlistFile in the new build system.
ensure_script_phase(
  app, 'Namu debug ATS localhost',
  "\"${SRCROOT}/scripts/debug_ats_localhost.sh\"\n",
  inputs: ['$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)'],
  before: 'Bundle React Native code and images'
)

# ---------------------------------------------------------------------------
# unit-test target
# ---------------------------------------------------------------------------
tests = project.targets.find { |t| t.name == TEST_TARGET }
unless tests
  tests = Xcodeproj::Project::Object::PBXNativeTarget.new(project, TEST_TARGET_UUID)
  project.targets << tests
  tests.name = TEST_TARGET
  tests.product_name = TEST_TARGET
  tests.product_type = Xcodeproj::Constants::PRODUCT_TYPE_UTI[:unit_test_bundle]
  tests.build_configuration_list = Xcodeproj::Project::ProjectHelper.configuration_list(
    project, :ios, DEPLOYMENT_TARGET, :unit_test_bundle, :swift
  )
  product = project.products_group.new_reference("#{TEST_TARGET}.xctest", :built_products)
  product.include_in_index = '0'
  product.set_explicit_file_type('wrapper.cfbundle')
  tests.product_reference = product
  tests.build_phases << project.new(Xcodeproj::Project::Object::PBXSourcesBuildPhase)
  tests.build_phases << project.new(Xcodeproj::Project::Object::PBXFrameworksBuildPhase)
  tests.build_phases << project.new(Xcodeproj::Project::Object::PBXResourcesBuildPhase)
  tests.add_dependency(app)
end

tests.build_configurations.each do |config|
  s = config.build_settings
  s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
  s['PRODUCT_BUNDLE_IDENTIFIER'] = 'org.namuai.offline.tests'
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['SWIFT_VERSION'] = '5.0'
  s['GENERATE_INFOPLIST_FILE'] = 'YES'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/Namu.app/Namu'
  s['BUNDLE_LOADER'] = '$(TEST_HOST)'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SDKROOT'] = 'iphoneos'
  s['SUPPORTED_PLATFORMS'] = 'iphoneos iphonesimulator'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']
  s['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG' if config.name == 'Debug'
  s.delete('INFOPLIST_FILE')
end

tests_group = ensure_group(project.main_group, TEST_TARGET, TEST_TARGET)
Dir.glob(File.join(IOS_DIR, 'NamuTests/*.swift')).sort.each do |file|
  ref = ensure_file(tests_group, File.basename(file))
  tests.source_build_phase.add_file_reference(ref, true) unless in_phase?(tests.source_build_phase, ref)
end

# Shared conformance vectors are referenced in place, never copied into ios/.
vectors_group = ensure_group(tests_group, 'Vectors', '../../model-release/test-vectors')
vectors = ensure_file(vectors_group, 'descriptor-vectors.json')
tests.resources_build_phase.add_file_reference(vectors, true) unless in_phase?(tests.resources_build_phase, vectors)

attributes = project.root_object.attributes
attributes['TargetAttributes'] ||= {}
attributes['TargetAttributes'][tests.uuid] ||= {}
attributes['TargetAttributes'][tests.uuid]['TestTargetID'] = app.uuid

project.save

# ---------------------------------------------------------------------------
# shared scheme: make sure the test action points at the NamuTests target
# ---------------------------------------------------------------------------
scheme_path = File.join(PROJECT_PATH, 'xcshareddata/xcschemes/Namu.xcscheme')
scheme = Xcodeproj::XCScheme.new(scheme_path)
testables = scheme.test_action.testables
unless testables.any? { |t| t.buildable_references.any? { |r| r.target_uuid == tests.uuid } }
  testables.each { |t| scheme.test_action.xml_element.elements['Testables'].delete_element(t.xml_element) }
  scheme.test_action.add_testable(Xcodeproj::XCScheme::TestAction::TestableReference.new(tests))
  scheme.save_as(PROJECT_PATH, 'Namu', true)
end

puts "configured #{PROJECT_PATH}"
