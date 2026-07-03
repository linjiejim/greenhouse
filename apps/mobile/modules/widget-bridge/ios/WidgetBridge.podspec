Pod::Spec.new do |s|
  s.name           = 'WidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'App Group shared-defaults bridge for the home-screen widget'
  s.description    = 'Writes the widget data snapshot into the shared App Group and reloads WidgetKit timelines.'
  s.author         = 'Greenhouse'
  s.homepage       = 'https://github.com/linjiejim/greenhouse'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
