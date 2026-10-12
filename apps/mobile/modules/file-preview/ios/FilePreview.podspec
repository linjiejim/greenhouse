Pod::Spec.new do |s|
  s.name = 'FilePreview'
  s.version = '1.0.0'
  s.summary = 'In-app Quick Look file previews'
  s.description = 'Native previews of authenticated files downloaded to the app cache.'
  s.author = 'Greenhouse'
  s.homepage = 'https://github.com/linjiejim/greenhouse'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
