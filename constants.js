// =============================================================================
// constants.js — central place for every tunable layout / appearance value.
//
// Edit the numbers below to change the whole visualization at once. This file
// is loaded before layout.js / render.js / panel.js / main.js (see index.html),
// so every constant here is available to all of them.
//
// Units are SVG user units (roughly pixels at zoom = 1).
// =============================================================================

// --- Node boxes (the rectangle drawn for each function node) -----------------
const NODE_PADDING_X = 16;   // horizontal padding around the label text (node width)
const NODE_PADDING_Y = 12;   // vertical padding around the label text (node height)
const NODE_CHAR_WIDTH = 6.5; // estimated width of one character
const NODE_LINE_HEIGHT = 16; // vertical space one text line gets in the box height
const NODE_MIN_WIDTH = 32;   // smallest a node box may become
const NODE_MIN_HEIGHT = 24;  // smallest a node box may become
const NODE_CORNER_RADIUS = 6;
const NODE_FONT_SIZE = 12;
const NODE_TEXT_LINE_SPACING = 16; // distance between two text lines inside the node

// --- Degree "hats" -----------------------------------------------------------
// Small bars above (incoming) and below (outgoing) a node. Their width grows
// with the number of connected edges; that height is what makes a node taller.
const HAT_HEIGHT = 10;             // <-- how tall the hats (top/bottom bars) are
const HAT_MIN_WIDTH = 3;          // "stick" width for a single edge
const HAT_MAX_WIDTH_RATIO = 0.9; // a bit less than the node width
const HAT_CORNER_RADIUS = 1.5;

// --- Folder / file bounding boxes -------------------------------------------
// BOX_PADDING is the gap between the nodes inside a box and the box border.
const BOX_PADDING = 20;        // <-- padding around the nodes in folder/file boxes
const FOLDER_BOX_PAD_TOP = 40; // extra room above nodes for the folder title
const FOLDER_BOX_PAD_BOTTOM = 20;
const FILE_BOX_PAD_TOP = 20;   // extra room above nodes for the file title
const FILE_BOX_PAD_BOTTOM = 20;
const FOLDER_BOX_CORNER_RADIUS = 12;
const FILE_BOX_CORNER_RADIUS = 10;

// --- Layout spacing ----------------------------------------------------------
const X_SPACING_BETWEEN_NODES = 30;  // horizontal gap between nodes side by side
const DEFAULT_Y_SPACING = 160;       // minimum vertical gap between two levels (orthogonal routing)
const Y_SPACING_EXTRA = 80;          // extra room reserved under a level for orthogonal edge lanes
const MIN_LANE_GAP = 4;              // vertical space per edge lane

// Tight spacing used when orthogonal edges are NOT being displayed (straight
// edges or no edges at all). Orthogonal routing needs vertical room to fan out
// its horizontal lanes; without it that space is just dead gaps between rows,
// so collapse the levels down to the node height plus the vertical padding that
// the file boxes need. Two boxes in adjacent rows must not overlap: each adds
// FILE_BOX_PAD_TOP above and FILE_BOX_PAD_BOTTOM below its nodes, so the gap
// between two rows has to be at least their sum.
const TIGHT_Y_SPACING = 64;          // minimum vertical gap between two levels (tight layout)
const TIGHT_Y_SPACING_EXTRA = FILE_BOX_PAD_TOP + FILE_BOX_PAD_BOTTOM; // room for adjacent boxes' padding
const COLUMN_SLOT_GAP = 40;          // gap between adjacent column slots
const COLLAPSED_WIDTH = 16;          // width of a collapsed folder/file column
const GRAPH_MARGIN = 32;             // outer margin of the whole graph
const FOCUS_GRAPH_MARGIN = 24;       // outer margin when focused on a node
const MIN_SVG_WIDTH = 900;           // smallest canvas width

// --- Edges -------------------------------------------------------------------
// When the "Thick Edges" toggle is on, stroke width is scaled logarithmically
// with the call frequency between these two bounds.
const EDGE_WIDTH_MIN = 1;
const EDGE_WIDTH_MAX = 8;
