Pod::Spec.new do |s|
  s.name           = 'WidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'App Group bridge for the home-screen widget, and Bot tasks as Live Activities'
  s.description    = 'Writes the widget data snapshot into the shared App Group and reloads WidgetKit timelines.'
  s.author         = 'Greenhouse'
  s.homepage       = 'https://github.com/linjiejim/greenhouse'
  s.license        = { :type => 'MIT' }
  # the app's own minimum (SDK 57): ActivityKit's types (16.1 / 16.2) need no availability checks
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
