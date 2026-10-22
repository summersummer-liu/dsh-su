# ============================================================================
# DSH SketchUp Bridge  ·  su_bridge_server.rb
# ----------------------------------------------------------------------------
# In-process TCP JSON-lines command server for SketchUp 2023 (Ruby 2.7).
# Mirrors the Rhino "ScriptServer" idea: keep one SketchUp instance alive and
# drive it from Python (su_bridge.py) instead of restarting the app per task.
#
# All Ruby API work runs on the main thread inside a UI.start_timer poll loop,
# which is the only thread-safe way to touch Sketchup.active_model.
#
# Protocol: one JSON object per line.
#   request : {"id":"a1","cmd":"run","script":"C:/abs/x.rb","args":{...}}
#   response: {"id":"a1","ok":true,"result":{...}}
#             {"id":"a1","ok":false,"error":"...","backtrace":[...]}
#
# Commands: ping info setup run eval save capture open new quit
# ============================================================================
begin
  require 'socket'
  require 'json'
  require 'fileutils'
rescue LoadError
  # Socket/JSON are stdlib and always present in SketchUp's Ruby; ignore.
end

module DSH
  module SuBridge
    EXT_DIR  = File.dirname(__FILE__).freeze unless defined?(EXT_DIR)
    DATA_DIR = ((ENV['LOCALAPPDATA'] || ENV['TEMP'] || '.').tr('\\', '/') + '/dsh-su') unless defined?(DATA_DIR)
    VERSION  = (File.read(File.join(EXT_DIR, 'VERSION')).strip rescue '0.0.0').freeze unless defined?(VERSION)
    HOST     = '127.0.0.1'.freeze unless defined?(HOST)
    # Port can be overridden by %LOCALAPPDATA%/dsh-su/config.json written by the DSH plugin.
    PORT = (begin
      _cfg = File.join(DATA_DIR, 'config.json')
      if File.file?(_cfg)
        require 'json'
        ((JSON.parse(File.read(_cfg))['port'] || 47311).to_i)
      else
        47311
      end
    rescue Exception
      47311
    end) unless defined?(PORT)
    ROOT    = DATA_DIR.freeze unless defined?(ROOT)
    LOG     = File.join(DATA_DIR, 'logs', 'bridge.log').freeze unless defined?(LOG)
    READY   = File.join(DATA_DIR, 'logs', 'ready.json').freeze unless defined?(READY)
    TMP     = File.join(DATA_DIR, 'tmp').freeze unless defined?(TMP)
    IN2M    = 0.0254 unless defined?(IN2M)

    class << self
      attr_reader :timer

      # Hot-reload this very file inside the running SketchUp session, so Ruby
      # edits do not cost a full app restart (Ruby parses the whole file first,
      # so a syntax error leaves the previous implementation in place).
      def cmd_reload(_req)
        path = __FILE__
        load(path)
        { 'reloaded' => path, 'version' => VERSION }
      end

      # ---- lifecycle ------------------------------------------------------
      def startup
        return if @timer
        FileUtils.mkdir_p(File.dirname(LOG)) rescue nil
        FileUtils.mkdir_p(TMP) rescue nil

        begin
          @server = TCPServer.new(HOST, PORT)
        rescue Errno::EADDRINUSE
          log("port #{PORT} already in use; bridge not started")
          return
        rescue => e
          log("bind failed: #{e.class}: #{e.message}")
          return
        end

        begin
          @server.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
        rescue
        end

        @clients = []
        @timer = UI.start_timer(0.1, true) { poll }
        write_ready
        log("bridge #{VERSION} listening on #{HOST}:#{PORT} pid=#{Process.pid} " \
            "sketchup=#{Sketchup.version} ruby=#{RUBY_VERSION}")
      end

      def log(msg)
        File.open(LOG, 'a') do |f|
          f.puts("[#{Time.now.strftime('%Y-%m-%d %H:%M:%S.%L')}] #{msg}")
        end
      rescue
        nil
      end

      def write_ready
        payload = {
          'version' => VERSION, 'port' => PORT, 'pid' => pid,
          'sketchup' => Sketchup.version, 'ruby' => RUBY_VERSION, 'extension_version' => VERSION,
          'time' => Time.now.to_s
        }
        File.open(READY, 'w') { |f| f.write(JSON.generate(payload)) }
      rescue
        nil
      end

      def pid
        Process.pid
      rescue
        0
      end

      # ---- transport ------------------------------------------------------
      def poll
        accept_clients
        @clients.reject! { |c| service_client(c) }
      rescue Exception => e   # SyntaxError/LoadError are not StandardError
        log("poll error #{e.class}: #{e.message}")
      end

      def accept_clients
        return unless @server
        loop do
          begin
            sock = @server.accept_nonblock
            @clients << { sock: sock, buf: '' }
          rescue IO::WaitReadable, Errno::EINTR
            break
          rescue => e
            log("accept error #{e.class}: #{e.message}")
            break
          end
        end
      end

      # returns true when the client must be dropped
      def service_client(client)
        closed = false
        begin
          loop do
            chunk = client[:sock].read_nonblock(65_536)
            break if chunk.nil?
            client[:buf] << chunk
          end
        rescue IO::WaitReadable
          # no data right now
        rescue EOFError
          closed = true
        rescue => _e
          closed = true
        end

        while (idx = client[:buf].index("\n"))
          line = client[:buf].slice!(0..idx).chomp
          next if line.strip.empty?
          resp = dispatch(line)
          begin
            client[:sock].write(JSON.generate(resp) + "\n")
          rescue
            closed = true
          end
        end

        if closed
          begin
            client[:sock].close
          rescue
          end
        end
        closed
      end

      # ---- dispatch -------------------------------------------------------
      def dispatch(line)
        req = nil
        begin
          req = JSON.parse(line)
          raise 'request must be a JSON object' unless req.is_a?(Hash)
          id  = req['id']
          cmd = req['cmd'].to_s
          result = case cmd
                   when 'ping'    then cmd_ping
                   when 'info'    then cmd_info
                   when 'setup'   then cmd_setup(req)
                   when 'reset'   then cmd_reset(req)
                   when 'run'     then cmd_run(req)
                   when 'eval'    then cmd_eval(req)
                   when 'save'    then cmd_save(req)
                   when 'capture' then cmd_capture(req)
                   when 'open'    then cmd_open(req)
                   when 'new'     then cmd_new
                   when 'reload'  then cmd_reload(req)
                   when 'quit'    then cmd_quit
                   else raise "unknown cmd '#{cmd}'"
                   end
          { 'id' => id, 'ok' => true, 'result' => json_safe(result) }
        rescue Exception => e
          # rescue Exception on purpose: a SyntaxError in a task script must be
          # reported to the client instead of leaving the request unanswered.
          log("dispatch error #{e.class}: #{e.message}\n#{Array(e.backtrace).first(8).join("\n")}")
          {
            'id' => (req && req['id']),
            'ok' => false,
            'error' => "#{e.class}: #{e.message}",
            'backtrace' => Array(e.backtrace).first(12)
          }
        end
      end

      # ---- commands -------------------------------------------------------
      def cmd_ping
        {
          'version' => VERSION, 'pid' => pid, 'port' => PORT,
          'sketchup' => Sketchup.version, 'ruby' => RUBY_VERSION, 'extension_version' => VERSION,
          'has_model' => !Sketchup.active_model.nil?,
          'model_title' => (Sketchup.active_model.title rescue nil)
        }
      end

      def cmd_info
        m = Sketchup.active_model
        base = {
          'version' => VERSION, 'pid' => pid,
          'sketchup' => Sketchup.version, 'ruby' => RUBY_VERSION, 'extension_version' => VERSION,
          'has_model' => !m.nil?
        }
        return base if m.nil?

        ents = m.entities
        counts = count_types(ents)
        bb = m.bounds
        empty = ents.size.zero?
        base['model'] = {
          'title' => m.title,
          'path' => m.path,
          'modified' => m.modified?,
          'length_unit' => (m.options['UnitsOptions']['LengthUnit'] rescue nil),
          'entities_total' => ents.size,
          'edges' => counts[:edges],
          'faces' => counts[:faces],
          'groups' => counts[:groups],
          'components' => counts[:components],
          'images' => counts[:images],
          'materials' => m.materials.size,
          'tags' => m.layers.size,
          'bounds_m' => empty ? nil : {
            'min' => pt_m(bb.min),
            'max' => pt_m(bb.max),
            'size' => [
              ((bb.max.x - bb.min.x) * IN2M).round(6),
              ((bb.max.y - bb.min.y) * IN2M).round(6),
              ((bb.max.z - bb.min.z) * IN2M).round(6)
            ]
          }
        }
        base
      end

      def count_types(ents)
        c = { edges: 0, faces: 0, groups: 0, components: 0, images: 0 }
        ents.each do |e|
          case e
          when Sketchup::Edge      then c[:edges] += 1
          when Sketchup::Face      then c[:faces] += 1
          when Sketchup::Group     then c[:groups] += 1
          when Sketchup::ComponentInstance then c[:components] += 1
          when Sketchup::Image     then c[:images] += 1
          end
        end
        c
      end

      def cmd_setup(req)
        m = model!
        unit = req['length_unit'] || 4 # 4 = meters
        opts = m.options['UnitsOptions']
        opts['LengthUnit']      = unit
        opts['LengthFormat']    = 0
        opts['LengthPrecision'] = 3
        opts['AngleUnit']       = 0
        { 'length_unit' => unit, 'ok' => true, 'info' => cmd_info['model'] }
      end

      # Wipe the document down to an empty model (the shipped templates carry a
      # scale figure component, which would pollute every task).
      def cmd_reset(req)
        m = model!
        m.entities.clear!
        begin
          m.definitions.purge_unused
        rescue
          nil
        end
        begin
          m.materials.purge_unused
        rescue
          nil
        end
        begin
          m.active_layer = m.layers[0] if m.layers.size > 0
        rescue
          nil
        end
        { 'entities_total' => m.entities.size,
          'tags' => m.layers.size,
          'materials' => m.materials.size,
          'title' => m.title }
      end

      def cmd_run(req)
        script = req['script'].to_s
        raise "script not found: #{script}" unless File.file?(script)
        preflight_syntax!(script)   # 先编译：语法错立即回报，不要执行到一半挂住
        args = req['args'] || {}
        $ARGS = args
        $dsh_result = nil
        $LOAD_PATH.unshift(EXT_DIR) unless $LOAD_PATH.include?(EXT_DIR)
        purge_kit_cache
        t0 = Time.now
        load(script)
        elapsed = ((Time.now - t0) * 1000).round(1) rescue nil
        { 'script' => script, 'elapsed_ms' => elapsed,
          'result' => $dsh_result }
      end

      def cmd_eval(req)
        code = req['code'].to_s
        FileUtils.mkdir_p(TMP)
        path = File.join(TMP, "eval_#{Time.now.to_f.to_s.tr('.', '_')}.rb")
        File.open(path, 'w') { |f| f.write(code) }
        preflight_syntax!(path)
        $ARGS = req['args'] || {}
        $dsh_result = nil
        $LOAD_PATH.unshift(EXT_DIR) unless $LOAD_PATH.include?(EXT_DIR)
        purge_kit_cache
        t0 = Time.now
        load(path)
        elapsed = ((Time.now - t0) * 1000).round(1) rescue nil
        { 'eval_file' => path, 'elapsed_ms' => elapsed, 'result' => $dsh_result }
      end

      def cmd_save(req)
        m = model!
        path = req['path'].to_s
        raise 'save needs an absolute .skp path' if path.empty?
        FileUtils.mkdir_p(File.dirname(path))
        ok = m.save(path)
        {
          'path' => path, 'saved' => ok,
          'exists' => File.file?(path),
          'bytes' => (File.size(path) rescue 0),
          'title' => m.title, 'model_path' => m.path
        }
      end

      def cmd_capture(req)
        m = model!
        path = req['path'].to_s
        raise 'capture needs an absolute png path' if path.empty?
        width  = (req['width'] || 1280).to_i
        height = (req['height'] || 800).to_i
        FileUtils.mkdir_p(File.dirname(path))
        view = m.active_view
        if req['zoom'] != false
          begin
            view.zoom_extents
          rescue => e
            log("zoom_extents failed: #{e.class}: #{e.message}")
          end
        end
        view.invalidate rescue nil
        sleep(0.2)
        ok = view.write_image(path, width, height, true, 0.9)
        {
          'path' => path, 'written' => ok,
          'exists' => File.file?(path),
          'bytes' => (File.size(path) rescue 0),
          'width' => width, 'height' => height
        }
      end

      def cmd_open(req)
        path = req['path'].to_s
        raise "file not found: #{path}" unless File.file?(path)
        raise 'Sketchup.open_file not available' unless Sketchup.respond_to?(:open_file)
        Sketchup.open_file(path)
        { 'path' => path, 'title' => (Sketchup.active_model.title rescue nil) }
      end

      def cmd_new
        raise 'Sketchup.file_new not available' unless Sketchup.respond_to?(:file_new)
        Sketchup.file_new
        { 'title' => (Sketchup.active_model.title rescue nil) }
      end

      def cmd_quit
        log('quit requested')
        UI.start_timer(0.3, false) do
          begin
            m = Sketchup.active_model
            if m && m.modified?
              # SketchUp 2023 has no Model#modified= setter, and a real
              # "save changes?" modal would hang a headless run. Park the
              # document in tmp/ so quitting stays prompt-free.
              FileUtils.mkdir_p(TMP)
              m.save(File.join(TMP, 'quit_autosave.skp'))
            end
          rescue => e
            log("quit autosave skipped: #{e.class}: #{e.message}")
          end
          begin
            Sketchup.quit
          rescue => e
            log("quit error #{e.class}: #{e.message}")
          end
        end
        { 'quitting' => true, 'pid' => pid }
      end

      # ---- helpers --------------------------------------------------------
      # 预编译：SyntaxError 会以普通错误返回给客户端，避免脚本跑到一半中断/挂起
      def preflight_syntax!(path)
        RubyVM::InstructionSequence.compile_file(path)
        true
      rescue SyntaxError => e
        raise "SyntaxError in #{File.basename(path)}: #{e.message}"
      end

      # Ruby's require cache is the classic SketchUp pain point: after editing
      # su_kit.rb the old class would keep being used. Drop it before each load.
      def purge_kit_cache
        $LOADED_FEATURES.reject! { |f| f.end_with?('su_kit.rb') }
      end

      def model!
        m = Sketchup.active_model
        raise 'no active model in SketchUp (welcome screen or closing?)' if m.nil?
        m
      end

      def pt_m(pt)
        [pt.x * IN2M, pt.y * IN2M, pt.z * IN2M].map { |v| v.round(6) }
      end

      def json_safe(obj, depth = 0)
        return obj.to_s if depth > 8
        case obj
        when nil, true, false
          obj
        when Integer
          obj
        when Float
          obj.finite? ? obj : obj.to_s
        when Numeric
          obj.to_f
        when String
          s = obj.dup.force_encoding(Encoding::UTF_8)
          s.valid_encoding? ? s : s.encode('UTF-8', invalid: :replace, undef: :replace)
        when Symbol
          obj.to_s
        when Hash
          obj.each_with_object({}) { |(k, v), h| h[k.to_s] = json_safe(v, depth + 1) }
        when Array
          obj.map { |v| json_safe(v, depth + 1) }
        else
          obj.to_s
        end
      end
    end
  end
end

# Auto-start once per SketchUp session.
begin
  unless DSH::SuBridge.timer
    DSH::SuBridge.startup
  end
rescue => e
  begin
    require 'fileutils'
    _dir = File.join((ENV['LOCALAPPDATA'] || ENV['TEMP'] || '.').tr('\\', '/'), 'dsh-su', 'logs')
    FileUtils.mkdir_p(_dir)
    File.open(File.join(_dir, 'bridge.log'), 'a') do |f|
      f.puts("[startup-fail] #{e.class}: #{e.message}")
      f.puts(Array(e.backtrace).first(10).join("\n"))
    end
  rescue
  end
end


# ----------------------------------------------------------------------------
# Extension helpers (used by the "Extensions -> DSH Bridge" menu).
# ----------------------------------------------------------------------------
module DSH
  module SuBridge
    class << self
      def ext_dir
        EXT_DIR
      end

      # Stop the TCP server/timer and start it again (no SketchUp restart needed).
      def restart!
        begin
          UI.stop_timer(@timer) if @timer
        rescue StandardError
          nil
        end
        @timer = nil
        begin
          @server.close if @server
        rescue StandardError
          nil
        end
        @server = nil
        @clients = []
        startup
      end
    end
  end
end
