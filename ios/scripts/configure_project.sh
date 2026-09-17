#!/bin/sh
# Runs configure_project.rb with the xcodeproj gem that ships with CocoaPods.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
POD_BIN="$(command -v pod)"
# Homebrew's `pod` is a wrapper that exports GEM_HOME and execs the real script.
POD_GEM_HOME="$(sed -n 's/^GEM_HOME="\([^"]*\)".*/\1/p' "$POD_BIN" | head -n 1)"
if [ -n "$POD_GEM_HOME" ]; then
  RUBY_BIN="$(sed -n '1s/^#!//p' "$POD_GEM_HOME/bin/pod")"
  GEM_HOME="$POD_GEM_HOME" exec "$RUBY_BIN" "$HERE/configure_project.rb" "$@"
fi
# Bundler / system gem installs: xcodeproj is on the default gem path.
exec ruby "$HERE/configure_project.rb" "$@"
