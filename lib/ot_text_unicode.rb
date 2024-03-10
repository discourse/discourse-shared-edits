# frozen_string_literal: true

module OtTextUnicode
  LOCK = Mutex.new

  def self.context
    LOCK.synchronize do
      return @context if @context
      context = MiniRacer::Context.new
      context.eval("module = {exports: {}}")
      ot_path = File.expand_path("../../public/javascripts/text-unicode-dist.js", __FILE__)

      context.eval("window = {}; #{File.read(ot_path)}; ot = window.otLib.default.OtUnicode")

      @context = context
    end
  end

  def self.apply(text, ops = [])
    json = String === ops ? ops : ops.to_json
    context.eval("ot.apply(#{text.inspect}, #{json})")
  end

  def self.compose(ops1 = [], ops2 = [])
    json1 = String === ops1 ? ops1 : ops1.to_json
    json2 = String === ops2 ? ops2 : ops2.to_json
    context.eval("ot.compose(#{json1}, #{json2})")
  end

  def self.transform(ops1 = [], ops2 = [], side = "right")
    json1 = String === ops1 ? ops1 : ops1.to_json
    json2 = String === ops2 ? ops2 : ops2.to_json
    context.eval("ot.transform(#{json1}, #{json2}, #{side.inspect})")
  end
end
