# Agentigram UI instructions

Before implementing or modifying UI, read `PRODUCT.md` and `DESIGN.md`, then consult the relevant design guidelines in the shared Git submodule at `../finco/awesome-design-md/design-md/`. For Agentigram use `linear.app/DESIGN.md` and `apple/DESIGN.md`; for Questr use `airbnb/DESIGN.md` and `cal/DESIGN.md`. The references inform craft and accessibility; preserve this product's own identity and behavior.

The shared checkout is initialized from Finco with `git submodule update --init --recursive`. If it is unavailable, report that before implementing UI; do not silently copy reference files.

This redesign covers the Electron meeting room. Preserve secure preload boundaries, renderer IDs, IPC contracts, speech controls, collision review, focus and presentation modes. Structured events remain the source of truth.
