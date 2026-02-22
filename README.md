# Map Tracker — SillyTavern Extension

Interactive map tracker that visualizes character locations and movements during roleplay.

## Features

- **Automatic tracking** — AI reports locations via tool calling or text tags
- **Interactive canvas** — Zoom, pan, click nodes for detail panels
- **Sub-locations** — Hierarchical locations with drill-in navigation (`City > Market > Silk Stall`)
- **7 visual themes** — Midnight, Crimson Romance, Neon Lust, Sakura Dreams, Cyberpunk, Enchanted Forest, Abyss
- **Known location consistency** — Sends list of established locations to AI to prevent name drift
- **3D mode** — Toggle isometric perspective view with depth-sorted nodes, sphere shading, and floor grid
- **Unlimited depth** — No limit on sub-location hierarchy levels

---

## Changelog

### v1.4.0
- ✨ **3D mode** — Isometric perspective rendering with toggle button in header
- ✨ **Perspective floor grid** — Receding grid lines with depth-fading
- ✨ **Sphere shading** — 4-stop gradient with upper-left lighting in 3D mode
- ✨ **Drop shadows** — Elliptical shadows beneath nodes in 3D
- ✨ **Depth sorting** — Back-to-front rendering for correct overlap
- ✨ **Perspective scaling** — Nodes scale with distance for depth illusion
- ✨ **Unlimited depth** — Sub-location hierarchy no longer limited to 3 levels
- 🎨 **Visual overhaul** — Nebula clouds, shooting stars, ambient particles, edge energy dots, orbit rings, frosted glass discs

### v1.3.0
- ✨ **Sub-location navigation** — Locations now support hierarchy with `>` separator
- ✨ **Drill-in/out** — Click parent nodes to explore sub-locations inside
- ✨ **Breadcrumbs** — Navigate back through layers with clickable path trail + back button
- ✨ **Child indicator badges** — Animated dashed ring + count badge on nodes with children
- ✨ **Layer transition animation** — Smooth zoom+fade when entering/leaving a sub-location level
- ✨ **Known locations prompt** — AI receives a list of established location names for consistency
- 🎨 **Version display** — Version number shown in popout legend bar

### v1.2.0
- ✨ **7 visual themes** — Full color palettes for canvas + UI elements with smooth CSS transitions
- ✨ **Theme selector** — Dropdown in settings to switch between themes
- 🎨 **CSS custom properties** — All popout colors driven by `--mt-*` variables

### v1.1.0
- ✨ **Tool calling support** — AI calls `MapTrackerUpdate` function tool (preferred over text tags)
- ✨ **Stealth mode** — Tool calls are invisible to the user
- ✨ **Live status indicator** — Shows tool calling support status in settings
- 🐛 **Blank message fix** — AI instructed to always write response alongside tool call

### v1.0.0
- 🎉 **Initial release**
- Interactive canvas map with starfield background
- Force-directed node layout with animated edges
- Detail panel with character info and visit history
- Text tag parsing (`[MAP: Location | Character | Activity]`)
- Node deletion and clear-all functionality
- Zoom, pan, and resize controls
