Pod::Spec.new do |s|
  s.name           = 'NativeChart'
  s.version        = '1.0.0'
  s.summary        = 'Swift Charts for the chat transcript'
  s.description    = 'Bar, line and pie / doughnut charts drawn with Swift Charts for chart blocks in replies.'
  s.author         = 'Greenhouse'
  s.homepage       = 'https://github.com/linjiejim/greenhouse'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
