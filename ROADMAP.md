# Roadmap

## Generic Banner Slot Detection

Goal: replace the current color-dependent slot detection with a more generic
detector that can find the vertical banner slot even when the old banner changes
color, position, or campaign design.

Current limitation:

- The existing auto-detection mainly looks for a large green vertical area.
- This works for current COMFY screenshots, but can fail if the old banner is
  yellow, orange, black, seasonal, or otherwise not green.
- Fixed coordinates are not reliable because banner placement can change.
- Manual coordinate entry is not user-friendly.

Planned solution:

- Add a new primary mode: `Автопошук за розміром`.
- Detect the slot by approximate banner dimensions and aspect ratio, not color.
- Look for a vertical rectangle close to the expected slot size, for example
  around `156x304` px on current screenshots, with a small tolerance.
- Score candidates by:
  - width and height tolerance;
  - aspect ratio;
  - rectangular shape;
  - location inside the product grid area;
  - surrounding product-card context;
  - avoiding header, sidebar, cart/calendar, and other UI panels.
- Keep color-based detection as a fallback or optional mode.

UI improvements:

- Show detected candidate slots as visible frames on top of a preview.
- If several candidates are found, allow choosing `Варіант 1`, `Варіант 2`,
  `Варіант 3`.
- Avoid manual coordinate typing for the normal workflow.
- Once the user confirms the correct slot pattern, apply the same logic to the
  full batch.

Recommended default workflow after this change:

- `По парах`
- `Автопошук за розміром`
- `У слот`
