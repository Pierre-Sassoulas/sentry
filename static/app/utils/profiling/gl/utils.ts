import Fuse from 'fuse.js';
import {mat3, vec2} from 'gl-matrix';

import {FlamegraphFrame} from 'sentry/utils/profiling/flamegraphFrame';
import {FlamegraphRenderer} from 'sentry/utils/profiling/renderers/flamegraphRenderer';

import {clamp} from '../colors/utils';

export function createShader(
  gl: WebGLRenderingContext,
  type: WebGLRenderingContext['VERTEX_SHADER'] | WebGLRenderingContext['FRAGMENT_SHADER'],
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Could not create shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (success) {
    return shader;
  }

  gl.deleteShader(shader);
  throw new Error('Failed to compile shader');
}

export function createProgram(
  gl: WebGLRenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Could not create program');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  const success = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (success) {
    return program;
  }

  gl.deleteProgram(program);
  throw new Error('Failed to create program');
}

// Create a projection matrix with origins at 0,0 in top left corner, scaled to width/height
export function makeProjectionMatrix(width: number, height: number): mat3 {
  const projectionMatrix = mat3.create();

  mat3.identity(projectionMatrix);
  mat3.translate(projectionMatrix, projectionMatrix, vec2.fromValues(-1, 1));
  mat3.scale(
    projectionMatrix,
    projectionMatrix,
    vec2.divide(vec2.create(), vec2.fromValues(2, -2), vec2.fromValues(width, height))
  );

  return projectionMatrix;
}

const canvasToDisplaySizeMap = new Map<HTMLCanvasElement, [number, number]>();

function onResize(entries: ResizeObserverEntry[]) {
  for (const entry of entries) {
    let width;
    let height;
    let dpr = window.devicePixelRatio;
    // @ts-ignore use as a progressive enhancement, some browsers don't support this yet
    if (entry.devicePixelContentBoxSize) {
      // NOTE: Only this path gives the correct answer
      // The other paths are imperfect fallbacks
      // for browsers that don't provide anyway to do this
      // @ts-ignore
      width = entry.devicePixelContentBoxSize[0].inlineSize;
      // @ts-ignore
      height = entry.devicePixelContentBoxSize[0].blockSize;
      dpr = 1; // it's already in width and height
    } else if (entry.contentBoxSize) {
      if (entry.contentBoxSize[0]) {
        width = entry.contentBoxSize[0].inlineSize;
        height = entry.contentBoxSize[0].blockSize;
      } else {
        // @ts-ignore
        width = entry.contentBoxSize.inlineSize;
        // @ts-ignore
        height = entry.contentBoxSize.blockSize;
      }
    } else {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    }
    const displayWidth = Math.round(width * dpr);
    const displayHeight = Math.round(height * dpr);
    canvasToDisplaySizeMap.set(entry.target as HTMLCanvasElement, [
      displayWidth,
      displayHeight,
    ]);

    resizeCanvasToDisplaySize(entry.target as HTMLCanvasElement);
  }
}

export const watchForResize = (
  canvas: HTMLCanvasElement[],
  callback?: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void
): ResizeObserver => {
  const handler: ResizeObserverCallback = (entries, observer) => {
    onResize(entries);
    callback?.(entries, observer);
  };

  for (const c of canvas) {
    canvasToDisplaySizeMap.set(c, [c.width, c.height]);
  }

  const resizeObserver = new ResizeObserver(handler);

  try {
    // only call us of the number of device pixels changed
    canvas.forEach(c => {
      resizeObserver.observe(c, {box: 'device-pixel-content-box'});
    });
  } catch (ex) {
    // device-pixel-content-box is not supported so fallback to this
    canvas.forEach(c => {
      resizeObserver.observe(c, {box: 'content-box'});
    });
  }

  return resizeObserver;
};

export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  // Get the size the browser is displaying the canvas in device pixels.
  const size = canvasToDisplaySizeMap.get(canvas);

  if (!size) {
    const displayWidth = canvas.clientWidth * window.devicePixelRatio;
    const displayHeight = canvas.clientHeight * window.devicePixelRatio;

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    return false;
  }

  const [displayWidth, displayHeight] = size;
  // Check if the canvas is not the same size.
  const needResize = canvas.width !== displayWidth || canvas.height !== displayHeight;

  if (needResize) {
    // Make the canvas the same size
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  return needResize;
}

export function transformMatrixBetweenRect(from: Rect, to: Rect): mat3 {
  return mat3.fromValues(
    to.width / from.width,
    0,
    0,
    0,
    to.height / from.height,
    0,
    to.x - from.x * (to.width / from.width),
    to.y - from.y * (to.height / from.height),
    1
  );
}

// Utility class to manipulate a virtual rect element. Some of the implementations are based off
// speedscope, however they are not 100% accurate and we've made some changes. It is important to
// note that contructing a lot of these objects at draw time is expensive and should be avoided.
export class Rect {
  origin: vec2;
  size: vec2;

  constructor(x: number, y: number, width: number, height: number) {
    this.origin = vec2.fromValues(x, y);
    this.size = vec2.fromValues(width, height);
  }

  clone(): Rect {
    return Rect.From(this);
  }

  isValid(): boolean {
    return this.toMatrix().every(n => !isNaN(n));
  }

  isEmpty(): boolean {
    return this.width === 0 && this.height === 0;
  }

  static Empty(): Rect {
    return new Rect(0, 0, 0, 0);
  }

  static From(rect: Rect): Rect {
    return new Rect(rect.x, rect.y, rect.width, rect.height);
  }

  get x(): number {
    return this.origin[0];
  }
  get y(): number {
    return this.origin[1];
  }
  get width(): number {
    return this.size[0];
  }
  get height(): number {
    return this.size[1];
  }
  get left(): number {
    return this.x;
  }
  get right(): number {
    return this.left + this.width;
  }
  get top(): number {
    return this.y;
  }
  get bottom(): number {
    return this.top + this.height;
  }

  static decode(query: string | ReadonlyArray<string> | null | undefined): Rect | null {
    let maybeEncodedRect = query;

    if (typeof query === 'string') {
      maybeEncodedRect = query.split(',');
    }

    if (!Array.isArray(maybeEncodedRect)) {
      return null;
    }

    if (maybeEncodedRect.length !== 4) {
      return null;
    }

    const rect = new Rect(
      ...(maybeEncodedRect.map(p => parseFloat(p)) as [number, number, number, number])
    );

    if (rect.isValid()) {
      return rect;
    }

    return null;
  }

  static encode(rect: Rect): string {
    return rect.toString();
  }

  toString() {
    return [this.x, this.y, this.width, this.height].map(n => Math.round(n)).join(',');
  }

  toMatrix(): mat3 {
    const {width: w, height: h, x, y} = this;
    // it's easier to display a matrix as a 3x3 array. WebGl matrices are row first and not column first
    // https://webglfundamentals.org/webgl/lessons/webgl-matrix-vs-math.html
    // prettier-ignore
    return mat3.fromValues(
      w, 0, 0,
      0, h, 0,
      x, y, 1
    )
  }

  hasIntersectionWith(other: Rect): boolean {
    const top = Math.max(this.top, other.top);
    const bottom = Math.max(top, Math.min(this.bottom, other.bottom));
    if (bottom - top === 0) {
      return false;
    }

    const left = Math.max(this.left, other.left);
    const right = Math.max(left, Math.min(this.right, other.right));

    if (right - left === 0) {
      return false;
    }
    return true;
  }

  containsX(vec: vec2): boolean {
    return vec[0] >= this.left && vec[0] <= this.right;
  }
  containsY(vec: vec2): boolean {
    return vec[1] >= this.top && vec[1] <= this.bottom;
  }

  contains(vec: vec2): boolean {
    return this.containsX(vec) && this.containsY(vec);
  }

  containsRect(rect: Rect): boolean {
    return (
      // left bound
      this.left <= rect.left &&
      // right bound
      rect.right <= this.right &&
      // top bound
      this.top <= rect.top &&
      // bottom bound
      rect.bottom <= this.bottom
    );
  }

  leftOverlapsWith(rect: Rect): boolean {
    return rect.left <= this.left && rect.right >= this.left;
  }

  rightOverlapsWith(rect: Rect): boolean {
    return this.right >= rect.left && this.right <= rect.right;
  }

  overlapsX(other: Rect): boolean {
    return this.left <= other.right && this.right >= other.left;
  }

  overlapsY(other: Rect): boolean {
    return this.top <= other.bottom && this.bottom >= other.top;
  }

  overlaps(other: Rect): boolean {
    return this.overlapsX(other) && this.overlapsY(other);
  }

  transformRect(transform: mat3): Rect {
    const x = this.x * transform[0] + this.y * transform[3] + transform[6];
    const y = this.x * transform[1] + this.y * transform[4] + transform[7];
    const width = this.width * transform[0] + this.height * transform[3];
    const height = this.width * transform[1] + this.height * transform[4];

    return new Rect(
      x + (width < 0 ? width : 0),
      y + (height < 0 ? height : 0),
      Math.abs(width),
      Math.abs(height)
    );
  }

  /**
   * Returns a transform that inverts the y axis within the rect.
   * This causes the bottom of the rect to be the top of the rect and vice versa.
   */
  invertYTransform(): mat3 {
    return mat3.fromValues(1, 0, 0, 0, -1, 0, 0, this.y * 2 + this.height, 1);
  }

  withHeight(height: number): Rect {
    return new Rect(this.x, this.y, this.width, height);
  }

  withWidth(width: number): Rect {
    return new Rect(this.x, this.y, width, this.height);
  }

  withX(x: number): Rect {
    return new Rect(x, this.y, this.width, this.height);
  }

  withY(y: number) {
    return new Rect(this.x, y, this.width, this.height);
  }

  toBounds(): [number, number, number, number] {
    return [this.x, this.y, this.x + this.width, this.y + this.height];
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.width, this.height];
  }

  between(to: Rect): Rect {
    return new Rect(to.x, to.y, to.width / this.width, to.height / this.height);
  }

  translate(x: number, y: number): Rect {
    return new Rect(x, y, this.width, this.height);
  }

  translateX(x: number): Rect {
    return new Rect(x, this.y, this.width, this.height);
  }

  translateY(y: number): Rect {
    return new Rect(this.x, y, this.width, this.height);
  }

  scaleX(x: number): Rect {
    return new Rect(this.x, this.y, this.width * x, this.height);
  }

  scaleY(y: number): Rect {
    return new Rect(this.x, this.y, this.width, this.height * y);
  }

  scale(x: number, y: number): Rect {
    return new Rect(this.x * x, this.y * y, this.width * x, this.height * y);
  }

  scaleOriginBy(x: number, y: number): Rect {
    return new Rect(this.x * x, this.y * y, this.width, this.height);
  }

  scaledBy(x: number, y: number): Rect {
    return new Rect(this.x, this.y, this.width * x, this.height * y);
  }

  equals(rect: Rect): boolean {
    if (this.x !== rect.x) {
      return false;
    }
    if (this.y !== rect.y) {
      return false;
    }
    if (this.width !== rect.width) {
      return false;
    }
    if (this.height !== rect.height) {
      return false;
    }
    return true;
  }

  notEqualTo(rect: Rect): boolean {
    return !this.equals(rect);
  }
}

function getContext(canvas: HTMLCanvasElement, context: '2d'): CanvasRenderingContext2D;
function getContext(canvas: HTMLCanvasElement, context: 'webgl'): WebGLRenderingContext;
function getContext(canvas: HTMLCanvasElement, context: string): RenderingContext {
  const ctx =
    context === 'webgl'
      ? canvas.getContext(context, {antialias: false})
      : canvas.getContext(context);
  if (!ctx) {
    throw new Error(`Could not get context ${context}`);
  }
  return ctx;
}

// Exported separately as writing export function for each overload as
// breaks the line width rules and makes it harder to read.
export {getContext};

export function measureText(string: string, ctx?: CanvasRenderingContext2D): Rect {
  if (!string) {
    return Rect.Empty();
  }

  const context = ctx || getContext(document.createElement('canvas'), '2d');
  const measures = context.measureText(string);

  return new Rect(
    0,
    0,
    measures.width,
    // https://stackoverflow.com/questions/1134586/how-can-you-find-the-height-of-text-on-an-html-canvas
    measures.actualBoundingBoxAscent + measures.actualBoundingBoxDescent
  );
}

// Taken from speedscope, computes min/max by halving the high/low end
// of the range on each iteration as long as range precision is greater than the given precision.
export function findRangeBinarySearch(
  {low, high}: {high: number; low: number},
  fn: (val: number) => number,
  target: number,
  precision = 1
): [number, number] {
  // eslint-disable-next-line
  while (true) {
    if (high - low <= precision) {
      return [low, high];
    }

    const mid = (high + low) / 2;
    if (fn(mid) < target) {
      low = mid;
    } else {
      high = mid;
    }
  }
}

export function formatColorForFrame(
  frame: FlamegraphFrame,
  renderer: FlamegraphRenderer
): string {
  const color = renderer.getColorForFrame(frame);
  if (color.length === 4) {
    return `rgba(${color
      .slice(0, 3)
      .map(n => n * 255)
      .join(',')}, ${color[3]})`;
  }

  return `rgba(${color.map(n => n * 255).join(',')}, 1.0)`;
}

export const ELLIPSIS = '\u2026';
type TrimTextCenter = {
  end: number;
  length: number;
  start: number;
  text: string;
};

// Similar to speedscope's implementation, utility fn to trim text in the center with a small bias towards prefixes.
export function trimTextCenter(text: string, low: number): TrimTextCenter {
  if (low >= text.length) {
    return {
      text,
      start: 0,
      end: 0,
      length: 0,
    };
  }

  const prefixLength = Math.floor(low / 2);
  // Use 1 character less than the low value to account for ellipsis and favor displaying the prefix
  const postfixLength = low - prefixLength - 1;

  const start = prefixLength;
  const end = Math.floor(text.length - postfixLength + ELLIPSIS.length);
  const trimText = `${text.substring(0, start)}${ELLIPSIS}${text.substring(end)}`;

  return {
    text: trimText,
    start,
    end,
    length: end - start,
  };
}

// Utility function to compute a clamped view. This is essentially a bounds check
// to ensure that zoomed viewports stays in the bounds and does not escape the view.
export function computeClampedConfigView(
  newConfigView: Rect,
  {width, height}: {height: {max: number; min: number}; width: {max: number; min: number}}
) {
  if (!newConfigView.isValid()) {
    throw new Error(newConfigView.toString());
  }
  const clampedWidth = clamp(newConfigView.width, width.min, width.max);
  const clampedHeight = clamp(newConfigView.height, height.min, height.max);

  const maxX = width.max - clampedWidth;
  const maxY = clampedHeight >= height.max ? 0 : height.max - clampedHeight;

  const clampedX = clamp(newConfigView.x, 0, maxX);
  const clampedY = clamp(newConfigView.y, 0, maxY);

  return new Rect(clampedX, clampedY, clampedWidth, clampedHeight);
}

/**
 * computeHighlightedBounds determines if a supplied boundary should be reduced in size
 * or shifted based on the results of a trim operation
 */
export function computeHighlightedBounds(
  bounds: Fuse.RangeTuple,
  trim: TrimTextCenter
): Fuse.RangeTuple {
  if (!trim.length) {
    return bounds;
  }

  const isStartBetweenTrim = bounds[0] >= trim.start && bounds[0] <= trim.end;
  const isEndBetweenTrim = bounds[1] >= trim.start && bounds[1] <= trim.end;
  const isFullyTruncated = isStartBetweenTrim && isEndBetweenTrim;

  // example:
  // -[UIScrollView _smoothScrollDisplayLink:]

  // "smooth" in "-[UIScrollView _…ScrollDisplayLink:]"
  //                              ^^
  if (isFullyTruncated) {
    return [trim.start, trim.start + 1];
  }

  if (bounds[0] < trim.start) {
    // "ScrollView" in '-[UIScrollView _sm…rollDisplayLink:]'
    //                      ^--------^
    if (bounds[1] < trim.start) {
      return [bounds[0], bounds[1]];
    }

    // "smoothScroll" in -[UIScrollView _smooth…DisplayLink:]'
    //                                   ^-----^
    if (isEndBetweenTrim) {
      return [bounds[0], trim.start + 1];
    }

    // "smoothScroll" in -[UIScrollView _sm…llDisplayLink:]'
    //                                   ^---^
    if (bounds[1] > trim.end) {
      return [bounds[0], bounds[1] - trim.length + 1];
    }
  }

  // "smoothScroll" in -[UIScrollView _…scrollDisplayLink:]'
  //                                   ^-----^
  if (isStartBetweenTrim && bounds[1] > trim.end) {
    return [trim.start, bounds[1] - trim.length + 1];
  }

  // "display" in -[UIScrollView _…scrollDisplayLink:]'
  //                                     ^-----^
  if (bounds[0] > trim.end) {
    return [bounds[0] - trim.length + 1, bounds[1] - trim.length + 1];
  }

  throw new Error(`Unhandled case: ${JSON.stringify(bounds)} ${trim}`);
}

// Utility function to allow zooming into frames using a specific strategy. Supports
// min zooming and exact strategy. Min zooming means we will zoom into a frame by doing
// the minimal number of moves to get a frame into view - for example, if the view is large
// enough and the frame we are zooming to is just outside of the viewport to the right,
// we will only move the viewport to the right until the frame is in view. Exact strategy
// means we will zoom into the frame by moving the viewport to the exact location of the frame
// and setting the width of the view to that of the frame.
export function computeConfigViewWithStrategy(
  strategy: 'min' | 'exact',
  view: Rect,
  frame: Rect
): Rect {
  if (strategy === 'exact') {
    return frame.withHeight(view.height);
  }

  if (strategy === 'min') {
    // If frame is in view, do nothing
    if (view.containsRect(frame)) {
      return view;
    }

    // If view width <= frame width, we need to zoom out, so the behavior is the
    // same as if we were using 'exact'
    if (view.width <= frame.width) {
      return frame.withHeight(view.height);
    }

    // If frame is to the left of the view, translate it left
    // to frame.x so that start of the frame is in the view
    let offset = view.clone();
    if (frame.left < view.left) {
      offset = offset.withX(frame.x);
    } else if (frame.right > view.right) {
      // If the right boundary of a frame is outside of the view, translate the view
      // by the difference between the right edge of the frame and the right edge of the view
      offset = view.withX(offset.x + frame.right - offset.right);
    }

    // If frame is above the view, translate view to top of frame
    if (frame.bottom < view.top) {
      offset = offset.withY(frame.top);
    } else if (frame.bottom > view.bottom) {
      // If frame is below the view, translate view by the difference
      // of the bottom edge of the frame and the view
      offset = offset.translateY(offset.y + frame.bottom - offset.bottom);
    }

    return offset;
  }

  return frame.withHeight(view.height);
}
