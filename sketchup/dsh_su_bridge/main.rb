# ============================================================================
# DSH Bridge  ·  main.rb  (SketchUp extension entry)
# ----------------------------------------------------------------------------
# Loaded by SketchupExtension after the loader registers it. Adds the
# "Extensions -> DSH Bridge" menu and starts the TCP server.
# ============================================================================
require 'sketchup'
require 'extensions'

EXT_DIR = File.dirname(__FILE__).freeze unless defined?(EXT_DIR)
require File.join(EXT_DIR, 'server') unless defined?(DSH::SuBridge) && DSH::SuBridge.timer

module DSH
  module SuBridge
    module Menu
      def self.status_text
        info = begin
          DSH::SuBridge.cmd_ping
        rescue StandardError => e
          { 'error' => "#{e.class}: #{e.message}" }
        end
        model = begin
          Sketchup.active_model && Sketchup.active_model.title
        rescue StandardError
          nil
        end
        lines = []
        lines << "DSH Bridge #{DSH::SuBridge::VERSION}"
        lines << "Host/Port: #{DSH::SuBridge::HOST}:#{DSH::SuBridge::PORT}"
        lines << "Server PID: #{info['pid'] || '-'}"
        lines << "Model: #{model || '(none)'}"
        lines << "Extension: #{DSH::SuBridge::EXT_DIR}"
        lines << "Log: #{DSH::SuBridge::LOG}"
        lines.join("\n")
      end

      def self.open_log_folder
        dir = File.dirname(DSH::SuBridge::LOG)
        begin
          require 'fileutils'
          FileUtils.mkdir_p(dir)
        rescue StandardError
          nil
        end
        UI.openURL("file:///#{dir.tr('\\', '/')}")
      end
    end
  end
end

unless file_loaded?(File.join(EXT_DIR, 'main.rb'))
  begin
    DSH::SuBridge.startup unless DSH::SuBridge.timer
  rescue StandardError => e
    DSH::SuBridge.log("main startup failed: #{e.class}: #{e.message}") rescue nil
  end

  begin
    dsh_menu = UI.menu('Extensions').add_submenu('DSH Bridge')
    dsh_menu.add_item('Status / 状态') { UI.messagebox(DSH::SuBridge::Menu.status_text) }
    dsh_menu.add_item('Open log folder / 打开日志') { DSH::SuBridge::Menu.open_log_folder }
    dsh_menu.add_separator
    dsh_menu.add_item('Restart server / 重启服务') do
      begin
        DSH::SuBridge.restart!
        UI.messagebox("DSH Bridge restarted on #{DSH::SuBridge::HOST}:#{DSH::SuBridge::PORT}")
      rescue StandardError => e
        UI.messagebox("DSH Bridge restart failed:\n#{e.class}: #{e.message}")
      end
    end
  rescue StandardError => e
    DSH::SuBridge.log("menu setup failed: #{e.class}: #{e.message}") rescue nil
  end

  file_loaded(File.join(EXT_DIR, 'main.rb'))
end
