# frozen_string_literal: true

namespace :shared_edits do
  namespace :yjs do
    desc "Rebuild bundled Yjs for the shared edits plugin (do not edit the bundled file manually)"
    task :build do
      cmd = [
        "cd",
        Rails.root.join("plugins", "discourse-shared-edits"),
        "&&",
        "pnpm exec esbuild node_modules/yjs/dist/yjs.mjs --bundle --format=iife --global-name=Y --platform=browser --outfile=public/javascripts/yjs-dist.js",
      ].join(" ")

      system(cmd) || raise("Failed to bundle Yjs")
    end
  end
end
