#!/usr/bin/env bash
set -euo pipefail
node --input-type=module -e 'if(Number(process.versions.node.split(".")[0])<22)throw new Error("Install Node.js 22+ first")'
npm ci
if [ "$(id -u)" -eq 0 ]; then
  apt-get update
  apt-get install -y xvfb xauth xdotool openbox imagemagick x11-utils dbus-daemon
else
  sudo apt-get update
  sudo apt-get install -y xvfb xauth xdotool openbox imagemagick x11-utils dbus-daemon
fi
printf '%s\n' 'Install desktop Chrome or Edge if it is not already present. Run node app.js as your normal desktop user.'
