# frozen_string_literal: true

require "digest"
require "fileutils"
require "shellwords"

namespace :shared_edits do
  namespace :yjs do
    desc "Rebuild bundled Yjs for the shared edits plugin (do not edit the bundled file manually)"
    task :build do
      plugin_dir = Rails.root.join("plugins", "discourse-shared-edits")

      # Read ProseMirror modules from the namespaced object to avoid global pollution.
      # The shared-edit-manager.js capturePM() function populates this namespace.
      prosemirror_banner = <<~JS
        var require = ((discourseRequire) => (name) => {
          const ns = window.__sharedEditsProseMirror || {};
          const pmModules = {
            'prosemirror-state': ns.pmState,
            'prosemirror-view': ns.pmView,
            'prosemirror-model': ns.pmModel,
            'prosemirror-transform': ns.pmTransform,
            'prosemirror-commands': ns.pmCommands,
            'prosemirror-history': ns.pmHistory,
            'prosemirror-inputrules': ns.pmInputrules,
            'prosemirror-keymap': ns.pmKeymap,
            'yjs': (window.SharedEditsYjs && window.SharedEditsYjs.Y) || window.Y
          };
          if (pmModules[name]) return pmModules[name];
          if (discourseRequire) return discourseRequire(name);
          throw new Error("Could not find module " + name);
        })(window.require || window.requirejs);
      JS

      core_cmd = [
        "cd",
        plugin_dir,
        "&&",
        "pnpm exec esbuild yjs-entry.js --bundle --format=iife --global-name=SharedEditsYjs --platform=browser --outfile=public/javascripts/yjs-dist.js",
      ].join(" ")

      prosemirror_cmd = [
        "cd",
        plugin_dir,
        "&&",
        "pnpm exec esbuild yjs-prosemirror-entry.js --bundle --format=iife --platform=browser --outfile=public/javascripts/yjs-prosemirror.js",
        "--external:yjs",
        "--external:prosemirror-state",
        "--external:prosemirror-view",
        "--external:prosemirror-model",
        "--external:prosemirror-transform",
        "--external:prosemirror-commands",
        "--external:prosemirror-history",
        "--external:prosemirror-inputrules",
        "--external:prosemirror-keymap",
        "--banner:js=#{prosemirror_banner.shellescape}",
      ].join(" ")

      system(core_cmd) || raise("Failed to bundle Yjs core")
      system(prosemirror_cmd) || raise("Failed to bundle Yjs prosemirror")

      public_dir = plugin_dir.join("public", "javascripts")
      dist_path = public_dir.join("yjs-dist.js")
      prosemirror_path = public_dir.join("yjs-prosemirror.js")

      dist_hash = Digest::SHA256.file(dist_path).hexdigest[0, 12]
      prosemirror_hash = Digest::SHA256.file(prosemirror_path).hexdigest[0, 12]

      dist_hashed = public_dir.join("yjs-dist-#{dist_hash}.js").to_s
      prosemirror_hashed = public_dir.join("yjs-prosemirror-#{prosemirror_hash}.js").to_s

      FileUtils.cp(dist_path, dist_hashed)
      FileUtils.cp(prosemirror_path, prosemirror_hashed)

      Dir
        .glob(public_dir.join("yjs-dist-*.js"))
        .each { |path| FileUtils.rm_f(path) if path != dist_hashed }

      Dir
        .glob(public_dir.join("yjs-prosemirror-*.js"))
        .each { |path| FileUtils.rm_f(path) if path != prosemirror_hashed }

      FileUtils.rm_f(dist_path)
      FileUtils.rm_f(prosemirror_path)

      bundle_paths = <<~JS
        export const YJS_DIST_URL = "/plugins/discourse-shared-edits/javascripts/yjs-dist-#{dist_hash}.js";
        export const YJS_PROSEMIRROR_URL = "/plugins/discourse-shared-edits/javascripts/yjs-prosemirror-#{prosemirror_hash}.js";
      JS

      bundle_paths_file =
        plugin_dir.join(
          "assets",
          "javascripts",
          "discourse",
          "lib",
          "shared-edits",
          "bundle-paths.js",
        )
      FileUtils.mkdir_p(File.dirname(bundle_paths_file))
      File.write(bundle_paths_file, bundle_paths)
    end
  end
end
