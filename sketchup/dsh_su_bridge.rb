# ============================================================================
# DSH Bridge for SketchUp  ·  extension loader (Plugins\dsh_su_bridge.rb)
# ----------------------------------------------------------------------------
# Registers the "DSH Bridge" SketchUp extension. The implementation lives in
# the sibling folder dsh_su_bridge/ (main.rb, server.rb, su_kit.rb, VERSION).
#
# Installed automatically by the dsh-su DSH plugin (tool: su_install_extension)
# or manually by copying this file + the dsh_su_bridge/ folder into:
#   %APPDATA%\SketchUp\SketchUp 2023\SketchUp\Plugins\
# ============================================================================
require 'sketchup'
require 'extensions'

begin
  ext_root = File.join(File.dirname(__FILE__), 'dsh_su_bridge')
  version_file = File.join(ext_root, 'VERSION')
  version = File.file?(version_file) ? File.read(version_file).strip : '0.0.0'

  unless file_loaded?(__FILE__)
    extension = SketchupExtension.new('DSH Bridge (SU + DSH)',
                                      File.join(ext_root, 'main'))
    extension.version = version
    extension.description = 'Local TCP bridge between SketchUp and DeepSeek Harness (DSH). ' \
                            'Lets the DSH agent inspect, model, save and screenshot SketchUp documents.'
    extension.creator = 'DSH'
    extension.copyright = 'MIT'
    Sketchup.register_extension(extension, true)
    file_loaded(__FILE__)
  end
rescue Exception => e
  begin
    log_dir = File.join((ENV['LOCALAPPDATA'] || ENV['TEMP'] || '.').tr('\\', '/'), 'dsh-su', 'logs')
    require 'fileutils'
    FileUtils.mkdir_p(log_dir)
    File.open(File.join(log_dir, 'loader.log'), 'a') do |f|
      f.puts("[#{Time.now}] DSH loader error: #{e.class}: #{e.message}")
      f.puts(Array(e.backtrace).first(12).join("\n"))
    end
  rescue Exception
    nil
  end
end
