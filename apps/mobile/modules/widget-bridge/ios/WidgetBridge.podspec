Pod::Spec.new do |s|
  s.name           = 'WidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'App Group bridge for the home-screen widgets'
  s.description    = 'Writes the widgets data snapshot into the shared App Group and reloads WidgetKit timelines.'
  s.author         = 'Greenhouse'
  s.homepage       = 'https://github.com/linjiejim/greenhouse'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
