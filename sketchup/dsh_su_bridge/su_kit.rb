# ============================================================================
# su_kit.rb  ·  SketchUp-side modelling kit (the counterpart of rhino_kit.py)
# ----------------------------------------------------------------------------
# Loaded by task scripts that run through the bridge:
#
#   require 'su_kit'
#   k = SuKit::Kit.new
#   k.reset                      # empty model, metres
#   k.tag('01-SOLID', 'C8BFA8')  # create/ensure a tag with a colour
#   k.box([0,0,0], 1,1,1, tag: '01-SOLID')
#   k.save(ARGS['out'])
#
# Everything is metric (metres in, metres out); SketchUp stores inches
# internally and the kit converts at the boundary.
# ============================================================================
require 'sketchup'

module SuKit
  IN2M = 0.0254
  M2IN = 1.0 / IN2M

  def self.m(v)
    v.to_f * M2IN
  end

  def self.p(x, y, z = 0)
    Geom::Point3d.new(self.m(x), self.m(y), self.m(z))
  end

  def self.pt_m(pt)
    [pt.x * IN2M, pt.y * IN2M, pt.z * IN2M].map { |v| v.round(4) }
  end

  class Kit
    attr_reader :model

    def initialize
      @model = Sketchup.active_model
      raise 'SuKit: no active model' if @model.nil?
    end

    # ---- document -------------------------------------------------------
    def reset
      @model.entities.clear!
      begin
        @model.definitions.purge_unused
        @model.materials.purge_unused
      rescue StandardError
        nil
      end
      units(:m)
      self
    end

    # units(:m | :mm | :cm | :ft | :in)
    def units(u)
      code = { in: 0, ft: 1, mm: 2, cm: 3, m: 4, yd: 5 }[u] || 4
      opts = @model.options['UnitsOptions']
      opts['LengthUnit'] = code
      opts['LengthFormat'] = 0
      opts['LengthPrecision'] = 3
      opts['AngleUnit'] = 0
      code
    end

    def units_code
      @model.options['UnitsOptions']['LengthUnit']
    rescue StandardError
      nil
    end

    # ---- tags (SketchUp "layers") ---------------------------------------
    def tag(name, rgb = nil)
      t = @model.layers[name]
      unless t
        t = @model.layers.add(name)
      end
      t.color = rgb_to_color(rgb) if rgb
      @model.active_layer = t
      t
    end

    def use_tag(name)
      t = @model.layers[name] || @model.layers.add(name)
      @model.active_layer = t
      t
    end

    def rgb_to_color(rgb)
      r, g, b = case rgb
                when String
                  s = rgb.delete('#')
                  [s[0, 2].to_i(16), s[2, 2].to_i(16), s[4, 2].to_i(16)]
                when Array then rgb
                when Integer
                  [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255]
                end
      Sketchup::Color.new(r, g, b)
    end

    # ---- primitives -----------------------------------------------------
    def box(min, sx, sy, sz, tag: nil)
      use_tag(tag) if tag
      x, y, z = min
      pts = [
        SuKit.p(x, y, z), SuKit.p(x + sx, y, z),
        SuKit.p(x + sx, y + sy, z), SuKit.p(x, y + sy, z)
      ]
      f = @model.entities.add_face(pts)
      f.reverse! if f.normal.z < 0
      f.pushpull(SuKit.m(sz))
      f
    end

    def cylinder(center, radius, height, segments = 48, tag: nil)
      use_tag(tag) if tag
      c = SuKit.p(*center)
      f = @model.entities.add_face(
        @model.entities.add_circle(c, Geom::Vector3d.new(0, 0, 1),
                                   SuKit.m(radius), segments)
      )
      f.pushpull(-SuKit.m(height))
      f
    end

    # closed polygon from [[x,y],...] (CCW), extruded up by height
    def polygon_extrude(points, height, tag: nil)
      use_tag(tag) if tag
      pts = points.map { |x, y| SuKit.p(x, y, 0) }
      f = @model.entities.add_face(pts)
      f.reverse! if f.normal.z < 0
      f.pushpull(SuKit.m(height))
      f
    end

    # 2D 圆弧（XY 平面）。SketchUp 2023 实测签名：
    #   add_arc(center, xaxis, NORMAL, radius, start_angle, end_angle, num_segments)
    # 第 3 个参数是平面法线，不是 y 轴——传 Y 会把弧画进 XZ 面。
    def arc_2d(cx, cy, radius, start_deg, end_deg, segments = 24, tag: nil)
      use_tag(tag) if tag
      @model.entities.add_arc(
        SuKit.p(cx, cy, 0),
        Geom::Vector3d.new(1, 0, 0),
        Geom::Vector3d.new(0, 0, 1),
        SuKit.m(radius), start_deg.degrees, end_deg.degrees, segments
      )
    end

    # 3D polyline (edges only)
    def polyline(points, tag: nil)
      use_tag(tag) if tag
      pts = points.map { |x, y, z| SuKit.p(x, y, z || 0) }
      pts.each_cons(2) { |a, b| @model.entities.add_line(a, b) }
    end

    # ---- operations -----------------------------------------------------
    def group(name = nil, tag: nil)
      g = @model.entities.add_group
      g.name = name if name
      use_tag(tag) if tag
      yield(g) if block_given?
      g
    end

    def erase_all
      @model.entities.clear!
    end

    def smooth_curves(g = nil)
      ents = g ? g.entities : @model.entities
      ents.grep(Sketchup::Edge).each do |e|
        e.smooth = true
        e.soft = true
      end
      ents.grep(Sketchup::Face).each { |f| f.smooth = true rescue nil }
    end

    # ---- materials ------------------------------------------------------
    def material(name, rgb = nil, alpha = 1.0)
      mat = @model.materials[name] || @model.materials.add(name)
      mat.color = rgb_to_color(rgb) if rgb
      mat.alpha = alpha
      mat
    end

    def paint(entity, mat_name)
      mat = @model.materials[mat_name]
      return false unless mat
      if entity.is_a?(Sketchup::Face)
        entity.material = mat
      else
        entity.material = mat
        entity.entities.grep(Sketchup::Face).each { |f| f.material = mat } rescue nil
      end
      true
    end

    # ---- camera / view --------------------------------------------------
    def camera(eye, target, up = [0, 0, 1], lens: 50.0)
      cam = Sketchup::Camera.new(SuKit.p(*eye), SuKit.p(*target),
                                 Geom::Vector3d.new(*up))
      cam.focal_length = lens
      @model.active_view.camera = cam
      cam
    end

    def zoom_extents
      @model.active_view.zoom_extents
    rescue StandardError
      nil
    end

    # 在 zoom_extents 之后按系数后退，给构图留白（1.1 约 +10% 距离）
    # 注意：SketchUp 的 Geom::Vector3d 不支持「向量 * 标量」，必须逐分量算。
    def dolly_out(factor = 1.12)
      cam = @model.active_view.camera
      target = cam.target
      eye = cam.eye
      f = factor.to_f
      new_eye = Geom::Point3d.new(target.x + (eye.x - target.x) * f,
                                  target.y + (eye.y - target.y) * f,
                                  target.z + (eye.z - target.z) * f)
      lens = cam.focal_length
      new_cam = Sketchup::Camera.new(new_eye, target, cam.up)
      new_cam.focal_length = lens
      @model.active_view.camera = new_cam
      new_cam
    end

    def capture(path, width = 1600, height = 1000, antialias: true)
      v = @model.active_view
      v.invalidate rescue nil
      v.write_image(path, width, height, antialias, 0.9)
    end

    # ---- query ----------------------------------------------------------
    def bbox_m(entity = nil)
      bb = entity ? entity.bounds : @model.bounds
      {
        min: SuKit.pt_m(bb.min),
        max: SuKit.pt_m(bb.max),
        size: [
          ((bb.max.x - bb.min.x) * IN2M).round(4),
          ((bb.max.y - bb.min.y) * IN2M).round(4),
          ((bb.max.z - bb.min.z) * IN2M).round(4)
        ]
      }
    end

    def counts(container = nil)
      ents = container ? container.entities : @model.entities
      c = { edges: 0, faces: 0, groups: 0, components: 0, curves: 0, total: ents.size }
      ents.each do |e|
        case e
        when Sketchup::Edge then c[:edges] += 1
        when Sketchup::Face then c[:faces] += 1
        when Sketchup::Group then c[:groups] += 1
        when Sketchup::ComponentInstance then c[:components] += 1
        when Sketchup::Curve then c[:curves] += 1
        end
      end
      c
    end

    def summary(entity = nil)
      {
        title: @model.title,
        path: @model.path,
        units: units_code,
        counts: counts(entity),
        bbox_m: bbox_m(entity),
        tags: @model.layers.map(&:name),
        materials: @model.materials.map(&:name).first(12)
      }
    end

    # ---- io -------------------------------------------------------------
    def save(path)
      dir = File.dirname(path)
      Dir.mkdir(dir) unless File.directory?(dir)
      ok = @model.save(path)
      { path: path, saved: ok, exists: File.file?(path), bytes: (File.size(path) rescue 0) }
    end

    # SketchUp only exports what the Pro exporters bundle; keep this list small.
    def export(path)
      ok = @model.export(path)
      { path: path, exported: ok, exists: File.file?(path), bytes: (File.size(path) rescue 0) }
    end
  end
end

# ============================================================================
# v1.1 追加（2026-10-19 复盘优化）
#  - Chrono：分段计时，写 build_trace.log，定位建模慢点
#  - 面级基元：直接 add_face，材质精确、不产生 pushpull 组层级，便于按组拼装
#  - 显示/构图/白棚：把「白色影棚 + 柔阴影 + 地面隐藏取景」这类重复代码收进 kit
#  - sanity_bounds!：构建末尾自检包围盒，防止跑了几分钟才发现单位/坐标错
# ============================================================================
require 'fileutils' unless defined?(FileUtils)

module SuKit
  # 分段计时器
  class Chrono
    attr_reader :entries

    def initialize(path = nil)
      @path = path
      @entries = []
      @t0 = Time.now
      if @path
        begin
          FileUtils.mkdir_p(File.dirname(@path))
          File.open(@path, 'w') { |f| f.puts("start #{Time.now}") }
        rescue StandardError
          @path = nil
        end
      end
    end

    def tick(msg)
      now = Time.now
      ms = ((now - @t0) * 1000).round(1)
      @entries << [msg, ms]
      if @path
        begin
          File.open(@path, 'a') { |f| f.puts("#{now.strftime('%H:%M:%S')} +#{ms}ms #{msg}") }
        rescue StandardError
          nil
        end
      end
      ms
    end

    def summary
      @entries.map { |msg, ms| { 'step' => msg, 'ms' => ms } }
    end
  end

  class Kit
    # ---- 内部工具 ----
    def ents_of(x)
      x.is_a?(Sketchup::Entities) ? x : x.entities
    end

    def safe_face(ent, pts)
      ent.add_face(pts)
    rescue Exception
      nil
    end

    def orient_face(f, inner)
      return nil unless f
      c = f.bounds.center
      f.reverse! if f.normal.dot(c - inner) < 0
      f
    end

    # ---- 面级基元（米制） ----
    # 轴对齐/绕 Z 旋转的盒子：cx,cy 中心，cz 底面
    def box_f(parent, cx, cy, cz, sx, sy, sz, mat, ang = 0.0)
      ent = ents_of(parent)
      a = ang * Math::PI / 180.0
      ca = Math.cos(a); sa = Math.sin(a)
      hx = sx / 2.0; hy = sy / 2.0
      lp = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
      bot = lp.map { |x, y| SuKit.p(cx + x * ca - y * sa, cy + x * sa + y * ca, cz) }
      top = bot.map { |q| Geom::Point3d.new(q.x, q.y, q.z + SuKit.m(sz)) }
      cen = SuKit.p(cx, cy, cz + sz / 2.0)
      faces = [safe_face(ent, bot.reverse), safe_face(ent, top)]
      4.times { |i| j = (i + 1) % 4; faces << safe_face(ent, [bot[i], bot[j], top[j], top[i]]) }
      faces.compact.each { |f| orient_face(f, cen); f.material = mat }
      faces
    end

    # 沿任意线段 p0->p1（英寸 Point3d）的盒体：z/h/t 米
    def seg_box_f(parent, p0, p1, z, h, t, mat, outward = 0.0)
      ent = ents_of(parent)
      dx = p1.x - p0.x; dy = p1.y - p0.y
      len = Math.sqrt(dx * dx + dy * dy)
      return nil if len < 1e-6
      ux = dx / len; uy = dy / len
      px = -uy * (t * 0.5) / 0.0254
      py = ux * (t * 0.5) / 0.0254
      ox = -uy * outward / 0.0254
      oy = ux * outward / 0.0254
      zi = z / 0.0254
      hi = h / 0.0254
      lo = [[p0.x + px + ox, p0.y + py + oy], [p1.x + px + ox, p1.y + py + oy],
            [p1.x - px + ox, p1.y - py + oy], [p0.x - px + ox, p0.y - py + oy]]
             .map { |x, y| Geom::Point3d.new(x, y, zi) }
      hp = lo.map { |q| Geom::Point3d.new(q.x, q.y, zi + hi) }
      cen = Geom::Point3d.new((p0.x + p1.x) / 2.0 + ox, (p0.y + p1.y) / 2.0 + oy, zi + hi / 2.0)
      faces = [safe_face(ent, lo.reverse), safe_face(ent, hp)]
      4.times { |i| j = (i + 1) % 4; faces << safe_face(ent, [lo[i], lo[j], hp[j], hp[i]]) }
      faces.compact.each { |f| orient_face(f, cen); f.material = mat }
      faces
    end

    def cyl_f(parent, cx, cy, cz, r, h, seg, mat)
      ent = ents_of(parent)
      rb = []; rt = []
      seg.times do |i|
        a = 2 * Math::PI * i / seg
        rb << SuKit.p(cx + r * Math.cos(a), cy + r * Math.sin(a), cz)
        rt << SuKit.p(cx + r * Math.cos(a), cy + r * Math.sin(a), cz + h)
      end
      cen = SuKit.p(cx, cy, cz + h / 2.0)
      fb = safe_face(ent, rb.reverse); orient_face(fb, cen); fb.material = mat if fb
      ft = safe_face(ent, rt); orient_face(ft, cen); ft.material = mat if ft
      seg.times do |i|
        j = (i + 1) % seg
        f = safe_face(ent, [rb[i], rb[j], rt[j], rt[i]])
        next unless f
        orient_face(f, cen); f.material = mat
      end
      nil
    end

    def sphere_f(parent, cx, cy, cz, r, mat, su = 8, sv = 5)
      ent = ents_of(parent)
      rings = []
      (0..sv).each do |iv|
        phi = Math::PI * iv / sv
        z = cz + r * Math.cos(phi)
        rr = r * Math.sin(phi)
        ring = []
        (0...su).each do |iu|
          th = 2 * Math::PI * iu / su
          ring << SuKit.p(cx + rr * Math.cos(th), cy + rr * Math.sin(th), z)
        end
        rings << ring
      end
      cen = SuKit.p(cx, cy, cz)
      (0...sv).each do |iv|
        (0...su).each do |iu|
          j = (iu + 1) % su
          a = rings[iv][iu]; b = rings[iv][j]
          c = rings[iv + 1][j]; d = rings[iv + 1][iu]
          f = if iv.zero?
                safe_face(ent, [a, c, d])
              elsif iv == sv - 1
                safe_face(ent, [a, b, c])
              else
                safe_face(ent, [a, b, c, d])
              end
          next unless f
          orient_face(f, cen)
          f.material = mat
        end
      end
      nil
    end

    # 玻璃/网格等单面
    def glass_f(parent, pts, mat)
      f = safe_face(ents_of(parent), pts)
      f.material = mat if f
      f
    end

    # ---- 边线显示控制 ----
    # 隐藏指定容器里的边线；material_names 给定时只隐藏「相邻面全是这些材质」的边
    def edge_hide!(parent, material_names: nil)
      ents = ents_of(parent)
      n = 0
      ents.grep(Sketchup::Edge).each do |e|
        if material_names
          fs = e.faces
          next if fs.empty?
          next unless fs.all? { |f| f.material && material_names.include?(f.material.name) }
        end
        e.hidden = true
        n += 1
      end
      n
    end

    # ---- 3D 文字（参数按英寸，自动换算；失败返回 nil） ----
    def text3d(parent, string, at_m, height_m: 0.26)
      ent = ents_of(parent)
      g = ent.add_group
      ok = g.entities.add_3d_text(string, TextAlignLeft, 'Arial', false, false,
                                 height_m / 0.0254, 0.02 / 0.0254, 0.0, true, 0.004 / 0.0254)
      if ok && g.entities.size > 0 && (g.bounds.width * 0.0254) < 15.0
        # 乘序：SketchUp 的 A * B 表示「先 B 后 A」。文字平躺在 XY 面，
        # 必须先绕 X 轴立起来，再平移到目标位置；反过来会把文字旋到地下。
        g.transform!(Geom::Transformation.translation(SuKit.p(*at_m)) *
                     Geom::Transformation.rotation(Geom::Point3d.new(0, 0, 0),
                                                   Geom::Vector3d.new(1, 0, 0), 90.degrees))
        g
      else
        begin
          g.erase!
        rescue StandardError
          nil
        end
        nil
      end
    end

    # ---- 显示 / 构图 ----
    def white_studio!
      ro = @model.rendering_options
      w = Sketchup::Color.new(255, 255, 255)
      %w[BackgroundColor SkyColor HorizonColor GroundColor].each { |key| ro[key] = w }
      ro['DrawHorizon'] = false
      ro['DrawGround'] = false
      ro['DisplayFog'] = false
      ro['DisplaySketchAxes'] = false
      true
    rescue StandardError
      false
    end

    def shadow_setup!(light = 92, dark = 60, display: true, on_all_faces: false)
      si = @model.shadow_info
      si['DisplayShadows'] = display
      si['UseSunForAllShading'] = false
      si['DisplayOnAllFaces'] = on_all_faces
      si['Light'] = light
      si['Dark'] = dark
      si['Latitude'] = 47.218
      si['Longitude'] = -1.5536
      si['TZOffset'] = 2
      si['ShadowTime'] = Time.utc(2026, 10, 19, 11, 0, 0)
      true
    rescue StandardError
      false
    end

    # 取景：临时隐藏地面（否则被 90 m 地面撑小），缩放后再恢复
    def frame_view!(ground = nil, dolly: 0.94)
      begin
        ground.visible = false if ground
        @model.active_view.zoom_extents
        dolly_out(dolly)
      rescue StandardError
        nil
      ensure
        ground.visible = true if ground
      end
    end

    # ---- 自检：包围盒与预期尺寸偏差过大就抛错（防跑几分钟才发现错） ----
    def sanity_bounds!(expected, exclude_names: [], tol: 1.2)
      mn = [1e9, 1e9, 1e9]
      mx = [-1e9, -1e9, -1e9]
      @model.entities.grep(Sketchup::Group).each do |g|
        next if exclude_names.include?(g.name)
        bb = g.bounds
        a = bb.min.to_a.map { |v| v * IN2M }
        b = bb.max.to_a.map { |v| v * IN2M }
        3.times do |i|
          mn[i] = a[i] if a[i] < mn[i]
          mx[i] = b[i] if b[i] > mx[i]
        end
      end
      size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
      bad = []
      3.times { |i| bad << i if (size[i] - expected[i]).abs > tol }
      unless bad.empty?
        raise "sanity_bounds failed: got #{size.map { |v| v.round(2) }} expected ~#{expected.map { |v| v.round(2) }}"
      end
      { 'min' => mn.map { |v| v.round(2) }, 'max' => mx.map { |v| v.round(2) },
        'size' => size.map { |v| v.round(2) } }
    end

    # 递归统计面/边（Group 嵌套也计入）
    def deep_counts(entity)
      f = 0; e = 0
      entity.entities.each do |c|
        if c.is_a?(Sketchup::Group)
          sub = deep_counts(c)
          f += sub[0]; e += sub[1]
        elsif c.is_a?(Sketchup::Face)
          f += 1
        elsif c.is_a?(Sketchup::Edge)
          e += 1
        end
      end
      [f, e]
    end
  end
end
