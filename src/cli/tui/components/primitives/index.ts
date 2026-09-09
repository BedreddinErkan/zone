/**
 * Phase 2b layout primitives — pure, stateless presentation components.
 *
 * None of these touch the store, dispatch actions, or register input handlers. They read
 * colours, glyphs, and layout tokens from theme.ts exclusively — the Phase 2a lint rule
 * (themeCoverage.test.ts) forbids hard-coded spacing/width literals on every .tsx under
 * src/cli/tui, including these.
 *
 * Not wired into App.tsx in this phase. Phase 2c replaces the 14 existing modal bodies with
 * compositions over these primitives; Phase 2d replaces inline panels (PlanPanel,
 * QuestionPanel) with Panel.
 */
export { KeyHints, type KeyHint } from "./KeyHints.js";
export { OverlayShell, type OverlayShellProps } from "./OverlayShell.js";
export { Row, type RowProps } from "./Row.js";
export { SectionTitle, type SectionTitleProps } from "./SectionTitle.js";
export { ListItem, type ListItemProps } from "./ListItem.js";
export { IndentedWrap, type IndentedWrapProps } from "./IndentedWrap.js";
export { Panel, type PanelProps } from "./Panel.js";
