# Art direction

This file is read by the AI before it touches any scene. Describe the look and feel you want and it will follow it.

## Canvas
- Soft off-white background (`--bg` in theme.css), lots of empty space. One idea per scene.
- 1920×1080. Keep important content inside a 120px safe margin.

## Typography
- Headlines: Inter, 600–700 weight, tight tracking (-0.04em), 96–160px. Sentence case, no trailing period unless it is a statement.
- Supporting labels: 20–28px, `--muted` colour.

## Motion
- Confident and calm: `expo.out` / `power3.out` for entrances, `power2.inOut` for moves. No bounce, no elastic.
- Words and UI parts stagger 40–80ms apart. Blur-in (8–16px) on large text reads as premium.
- Every scene starts and ends on a composed frame so cuts feel deliberate.

## UI recreations
- Rebuild interface pieces from the real codebase: same copy, spacing, radii, colours and icons.
- Prefer crisp HTML/CSS recreations over screenshots, so they can animate part by part.
