#!/usr/bin/env bash
# Builds a small synthetic shoot folder for trying `video-mcp sort` end to end (macOS: uses `say`).
# Usage: scripts/make-sort-fixture.sh <out-dir>
set -euo pipefail

out="${1:?usage: make-sort-fixture.sh <out-dir>}"
raw="$out/raw"
mkdir -p "$raw"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ff() { ffmpeg -loglevel error -y "$@"; }

# A-roll: a synthetic picture with spoken audio from `say`.
talk() {
  local name="$1" video="$2" text="$3"
  say -o "$tmp/$name.aiff" "$text"
  ff -f lavfi -i "$video" -i "$tmp/$name.aiff" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$raw/$name.mp4"
}

talk intro_take1 "testsrc2=s=1280x720:r=30:d=30" \
  "Welcome to the setup tutorial. Today we, um, sorry. Wait. Let me start that again."
talk intro_take2 "testsrc2=s=1280x720:r=30:d=30" \
  "Welcome to the setup tutorial. Today we unbox the desk lamp and plug it into the wall."
talk coffee_talk "smptebars=s=1280x720:r=30:d=30" \
  "Now let's talk about making coffee. First grind the beans, then heat the water to ninety degrees."

# B-roll: silent-ish visuals with room tone.
ff -f lavfi -i "mandelbrot=s=1280x720:r=30" -f lavfi -i "anoisesrc=a=0.002:d=6" -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac "$raw/fractal_zoom.mp4"
ff -i "$raw/fractal_zoom.mp4" -c:v libx264 -crf 30 -pix_fmt yuv420p -c:a copy "$raw/fractal_zoom_copy.mp4"
ff -f lavfi -i "life=s=640x360:mold=10:r=30:ratio=0.1:death_color=#C83232:life_color=#00ff00" -t 6 -c:v libx264 -pix_fmt yuv420p "$raw/cells_timelapse.mp4"

# Junk: lens cap and an accidental half-second tap.
ff -f lavfi -i "color=black:s=1280x720:r=30:d=4" -f lavfi -i "anoisesrc=a=0.001:d=4" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$raw/lens_cap.mp4"
ff -f lavfi -i "testsrc2=s=1280x720:r=30:d=0.5" -c:v libx264 -pix_fmt yuv420p "$raw/blip.mp4"

ls -1 "$raw"
