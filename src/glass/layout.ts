export interface TileLayoutInput {
  tileCount: number;
  mainWidth: number;
  mainHeight: number;
  minTileWidth: number;
  minTileHeight: number;
  focusedIndex: number;
  scrollRow: number;
}

export interface TileRect {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface TileLayout {
  columns: number;
  rows: number;
  scrollRow: number;
  tiles: TileRect[];
}

/**
 * Width-floored column layout. columns = clamp(floor(width/minTileWidth)) but
 * never more than the tile count; rows pack after columns fill. When more tile
 * rows exist than fit at the min height, the glass scrolls vertically and the
 * focused tile's row is kept in view.
 */
export function computeTileLayout(input: TileLayoutInput): TileLayout {
  const { tileCount, mainWidth, mainHeight, minTileWidth, minTileHeight, focusedIndex } = input;

  const columns = Math.max(1, Math.min(tileCount, Math.floor(mainWidth / minTileWidth) || 1));
  const totalRows = Math.max(1, Math.ceil(tileCount / columns));
  const tileWidth = Math.floor(mainWidth / columns);

  const visibleRows = Math.max(1, Math.floor(mainHeight / minTileHeight));
  const rowsOnScreen = Math.min(totalRows, visibleRows);
  const tileHeight = Math.floor(mainHeight / rowsOnScreen);

  // Keep the focused tile's row within [scrollRow, scrollRow + visibleRows).
  const focusedRow = Math.floor(focusedIndex / columns);
  const maxScroll = Math.max(0, totalRows - visibleRows);
  let scrollRow = Math.min(Math.max(0, input.scrollRow), maxScroll);
  if (focusedRow < scrollRow) scrollRow = focusedRow;
  else if (focusedRow >= scrollRow + visibleRows) scrollRow = focusedRow - visibleRows + 1;

  const tiles: TileRect[] = [];
  for (let i = 0; i < tileCount; i++) {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const visible = row >= scrollRow && row < scrollRow + visibleRows;
    tiles.push({
      index: i,
      x: col * tileWidth,
      y: (row - scrollRow) * tileHeight,
      width: tileWidth,
      height: tileHeight,
      visible,
    });
  }

  return { columns, rows: totalRows, scrollRow, tiles };
}
