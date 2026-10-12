// Layout descriptors stay lightweight; only the viewport window needs DOM or PDF proxies.
export function layoutPages(pages, columns, zoom, gap) {
  const widths = Array(columns).fill(0);
  for (let i = 0; i < pages.length; i += 1) {
    widths[i % columns] = Math.max(widths[i % columns], pages[i].width * zoom);
  }
  const lefts = [0];
  for (let i = 1; i < columns; i += 1) lefts[i] = lefts[i - 1] + widths[i - 1] + gap;
  const rows = [];
  let top = 0;
  for (let start = 0; start < pages.length; start += columns) {
    const rowPages = pages.slice(start, start + columns);
    const height = Math.max(...rowPages.map((page) => page.height * zoom));
    for (let i = 0; i < rowPages.length; i += 1) {
      const page = rowPages[i];
      page.layoutLeft = lefts[i];
      page.layoutTop = top;
      page.layoutBottom = top + page.height * zoom;
    }
    rows.push({ top, bottom: top + height, pages: rowPages });
    top += height + gap;
  }
  return {
    rows,
    width: widths.reduce((sum, width) => sum + width, 0) + gap * (columns - 1),
    height: Math.max(0, top - gap),
  };
}

function firstRowEndingAfter(rows, y) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].bottom < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function pagesInWindow(rows, { top, bottom, left = -Infinity, right = Infinity }, zoom) {
  const result = [];
  for (let i = firstRowEndingAfter(rows, top); i < rows.length && rows[i].top <= bottom; i += 1) {
    for (const page of rows[i].pages) {
      if (page.layoutBottom >= top && page.layoutLeft <= right &&
          page.layoutLeft + page.width * zoom >= left) result.push(page);
    }
  }
  return result;
}

export function pageAtY(rows, y) {
  if (!rows.length) return null;
  let index = Math.min(firstRowEndingAfter(rows, y), rows.length - 1);
  if (rows[index + 1]?.top <= y) index += 1;
  const row = rows[index];
  for (const page of row.pages) {
    if (y >= page.layoutTop && y < page.layoutBottom) return page.pageNumber;
  }
  // In a gap, preserve the existing nearest-page-centre navigation behavior.
  let nearest = null;
  let distance = Infinity;
  for (const candidate of [rows[index - 1], row]) {
    for (const page of candidate?.pages ?? []) {
      const delta = Math.abs(y - (page.layoutTop + page.layoutBottom) / 2);
      if (delta < distance) { nearest = page.pageNumber; distance = delta; }
    }
  }
  return nearest;
}

export function rasterSize(width, height, deviceScale, maxPixels, maxDimension = 8192) {
  const scale = Math.min(deviceScale, Math.sqrt(maxPixels / (width * height)),
    maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}
