# Art direction: Storyboard teaser

A 20-second launch teaser for Storyboard itself. The codebase is the app, so UI recreations come from `src/components/*.svelte`.

## Canvas
- Off-white `--bg` (#fafafa) with lots of air. One idea per scene, centred.
- 1920×1080, 120px safe margin.

## Typography
- Headlines: Inter 650, -0.05em tracking, 120–170px.
- Accent words in Instrument Serif italic (`--font-serif`), slightly larger than the sans line.
- UI text at the app's real proportions, scaled up ~2×.

## Colour
- Neutral greys from Tailwind's neutral scale; black primary buttons.
- Blue (`--playhead`) only for the playhead and selection rings, violet (`--beat`) only for music beats.

## Motion
- `expo.out` entrances with 12–18px blur, 0.8–1.0s. Words stagger 0.08s, characters 0.035s.
- `power3.inOut` for camera-like moves and 3D rotations.
- Each scene exits quickly (≤0.35s) or cuts on a held composition.
