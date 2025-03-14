import {mat3, vec2} from 'gl-matrix';

import {Flamegraph} from '../flamegraph';
import {FlamegraphSearch} from '../flamegraph/flamegraphStateProvider/reducers/flamegraphSearch';
import {FlamegraphTheme} from '../flamegraph/flamegraphTheme';
import {FlamegraphFrame, getFlamegraphFrameSearchId} from '../flamegraphFrame';
import {
  createProgram,
  createShader,
  getContext,
  makeProjectionMatrix,
  Rect,
  resizeCanvasToDisplaySize,
} from '../gl/utils';

import {fragment, vertex} from './shaders';

class FlamegraphRenderer {
  canvas: HTMLCanvasElement | null;
  flamegraph: Flamegraph;

  gl: WebGLRenderingContext | null = null;
  program: WebGLProgram | null = null;

  theme: FlamegraphTheme;
  frames: ReadonlyArray<FlamegraphFrame> = [];
  roots: ReadonlyArray<FlamegraphFrame> = [];

  // Vertex and color buffer
  positions: Float32Array = new Float32Array();
  bounds: Float32Array = new Float32Array();
  colors: Float32Array = new Float32Array();
  searchResults: Float32Array = new Float32Array();

  colorMap: Map<string | number, number[]> = new Map();

  lastDragPosition: vec2 | null = null;

  attributes: {
    a_bounds: number | null;
    a_color: number | null;
    a_is_search_result: number | null;
    a_position: number | null;
  } = {
    a_position: null,
    a_color: null,
    a_bounds: null,
    a_is_search_result: null,
  };

  uniforms: {
    u_border_width: WebGLUniformLocation | null;
    u_draw_border: WebGLUniformLocation | null;
    u_model: WebGLUniformLocation | null;
    u_projection: WebGLUniformLocation | null;
  } = {
    u_border_width: null,
    u_draw_border: null,
    u_model: null,
    u_projection: null,
  };

  options: {
    draw_border: boolean;
  };

  constructor(
    canvas: HTMLCanvasElement,
    flamegraph: Flamegraph,
    theme: FlamegraphTheme,
    options: {draw_border: boolean} = {draw_border: false}
  ) {
    this.flamegraph = flamegraph;
    this.canvas = canvas;
    this.theme = theme;
    this.options = options;

    this.init();
  }

  init(): void {
    const VERTICES = 6;
    const COLOR_COMPONENTS = 4;

    this.colors = new Float32Array(VERTICES * COLOR_COMPONENTS);
    this.frames = [...this.flamegraph.frames];
    this.roots = [...this.flamegraph.root.children];

    // Generate colors for the flamegraph
    const {colorBuffer, colorMap} = this.theme.COLORS.STACK_TO_COLOR(
      this.frames,
      this.theme.COLORS.COLOR_MAP,
      this.theme.COLORS.COLOR_BUCKET
    );

    this.colorMap = colorMap;
    this.colors = new Float32Array(colorBuffer);

    this.initCanvasContext();
    this.initVertices();
    this.initShaders();
  }

  initVertices(): void {
    const POSITIONS = 2;
    const BOUNDS = 4;
    const VERTICES = 6;

    const FRAME_COUNT = this.frames.length;

    this.bounds = new Float32Array(VERTICES * BOUNDS * FRAME_COUNT);
    this.positions = new Float32Array(VERTICES * POSITIONS * FRAME_COUNT);
    this.searchResults = new Float32Array(FRAME_COUNT * VERTICES);

    for (let index = 0; index < FRAME_COUNT; index++) {
      const frame = this.frames[index];

      const x1 = frame.start;
      const x2 = frame.end;
      const y1 = frame.depth;
      const y2 = frame.depth + 1;

      // top left -> top right -> bottom left ->
      // bottom left -> top right -> bottom right
      const positionOffset = index * 12;

      this.positions[positionOffset] = x1;
      this.positions[positionOffset + 1] = y1;
      this.positions[positionOffset + 2] = x2;
      this.positions[positionOffset + 3] = y1;
      this.positions[positionOffset + 4] = x1;
      this.positions[positionOffset + 5] = y2;
      this.positions[positionOffset + 6] = x1;
      this.positions[positionOffset + 7] = y2;
      this.positions[positionOffset + 8] = x2;
      this.positions[positionOffset + 9] = y1;
      this.positions[positionOffset + 10] = x2;
      this.positions[positionOffset + 11] = y2;

      // @TODO check if we can pack bounds across vertex calls,
      // we are allocating 6x the amount of memory here
      const boundsOffset = index * VERTICES * BOUNDS;

      for (let i = 0; i < VERTICES; i++) {
        const offset = boundsOffset + i * BOUNDS;

        this.bounds[offset] = x1;
        this.bounds[offset + 1] = y1;
        this.bounds[offset + 2] = x2;
        this.bounds[offset + 3] = y2;
      }
    }
  }

  initCanvasContext(): void {
    if (!this.canvas) {
      throw new Error('Cannot initialize context from null canvas');
    }
    // Setup webgl canvas context
    this.gl = getContext(this.canvas, 'webgl');

    if (!this.gl) {
      throw new Error('Uninitialized WebGL context');
    }

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFuncSeparate(
      this.gl.SRC_ALPHA,
      this.gl.ONE_MINUS_SRC_ALPHA,
      this.gl.ONE,
      this.gl.ONE_MINUS_SRC_ALPHA
    );
    resizeCanvasToDisplaySize(this.canvas);
  }

  initShaders(): void {
    if (!this.gl) {
      throw new Error('Uninitialized WebGL context');
    }

    this.uniforms = {
      u_border_width: null,
      u_draw_border: null,
      u_model: null,
      u_projection: null,
    };
    this.attributes = {
      a_bounds: null,
      a_color: null,
      a_is_search_result: null,
      a_position: null,
    };

    const vertexShader = createShader(this.gl, this.gl.VERTEX_SHADER, vertex());

    const fragmentShader = createShader(
      this.gl,
      this.gl.FRAGMENT_SHADER,
      fragment(this.theme)
    );

    // create program
    this.program = createProgram(this.gl, vertexShader, fragmentShader);

    const uProjectionMatrix = this.gl.getUniformLocation(this.program, 'u_projection');
    const uModelMatrix = this.gl.getUniformLocation(this.program, 'u_model');
    const uBorderWidth = this.gl.getUniformLocation(this.program, 'u_border_width');
    const uDrawBorder = this.gl.getUniformLocation(this.program, 'u_draw_border');

    if (!uProjectionMatrix) {
      throw new Error('Could not locate u_projection in shader');
    }
    if (!uModelMatrix) {
      throw new Error('Could not locate u_model in shader');
    }
    if (!uBorderWidth) {
      throw new Error('Could not locate u_border_width in shader');
    }
    if (!uDrawBorder) {
      throw new Error('Could not locate u_draw_border in shader');
    }

    this.uniforms.u_projection = uProjectionMatrix;
    this.uniforms.u_model = uModelMatrix;
    this.uniforms.u_border_width = uBorderWidth;
    this.uniforms.u_draw_border = uDrawBorder;

    {
      const aIsSearchResult = this.gl.getAttribLocation(
        this.program,
        'a_is_search_result'
      );

      if (aIsSearchResult === -1) {
        throw new Error('Could not locate a_is_search_result in shader');
      }

      // attributes get data from buffers
      this.attributes.a_is_search_result = aIsSearchResult;

      // Init color buffer
      const searchResultsBuffer = this.gl.createBuffer();

      // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = searchResultsBuffer)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, searchResultsBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.searchResults, this.gl.DYNAMIC_DRAW);

      const size = 1;
      const type = this.gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;

      this.gl.vertexAttribPointer(aIsSearchResult, size, type, normalize, stride, offset);
      // Point to attribute location
      this.gl.enableVertexAttribArray(aIsSearchResult);
    }

    {
      const aColorAttributeLocation = this.gl.getAttribLocation(this.program, 'a_color');

      if (aColorAttributeLocation === -1) {
        throw new Error('Could not locate a_color in shader');
      }

      // attributes get data from buffers
      this.attributes.a_color = aColorAttributeLocation;

      // Init color buffer
      const colorBuffer = this.gl.createBuffer();

      // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = colorBuffer)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.colors, this.gl.STATIC_DRAW);

      const size = 4;
      const type = this.gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;

      this.gl.vertexAttribPointer(
        aColorAttributeLocation,
        size,
        type,
        normalize,
        stride,
        offset
      );
      // Point to attribute location
      this.gl.enableVertexAttribArray(aColorAttributeLocation);
    }

    {
      // look up where the vertex data needs to go.
      const aPositionAttributeLocation = this.gl.getAttribLocation(
        this.program,
        'a_position'
      );

      if (aPositionAttributeLocation === -1) {
        throw new Error('Could not locate a_color in shader');
      }

      // attributes get data from buffers
      this.attributes.a_position = aPositionAttributeLocation;

      // Init position buffer
      const positionBuffer = this.gl.createBuffer();

      // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.positions, this.gl.STATIC_DRAW);

      const size = 2;
      const type = this.gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;

      this.gl.vertexAttribPointer(
        aPositionAttributeLocation,
        size,
        type,
        normalize,
        stride,
        offset
      );
      // Point to attribute location
      this.gl.enableVertexAttribArray(aPositionAttributeLocation);
    }

    {
      // look up where the bounds vertices needs to go.
      const aBoundsAttributeLocation = this.gl.getAttribLocation(
        this.program,
        'a_bounds'
      );

      if (aBoundsAttributeLocation === -1) {
        throw new Error('Could not locate a_color in shader');
      }

      // attributes get data from buffers
      this.attributes.a_bounds = aBoundsAttributeLocation;

      // Init bounds buffer
      const boundsBuffer = this.gl.createBuffer();

      // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = boundsBuffer)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, boundsBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.bounds, this.gl.STATIC_DRAW);

      const size = 4;
      const type = this.gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;

      this.gl.vertexAttribPointer(
        aBoundsAttributeLocation,
        size,
        type,
        normalize,
        stride,
        offset
      );
      // Point to attribute location
      this.gl.enableVertexAttribArray(aBoundsAttributeLocation);
    }

    // Use shader program
    this.gl.useProgram(this.program);
  }

  getColorForFrame(frame: FlamegraphFrame): number[] {
    return this.colorMap.get(frame.key) ?? this.theme.COLORS.FRAME_FALLBACK_COLOR;
  }

  findHoveredNode(configSpaceCursor: vec2): FlamegraphFrame | null {
    let hoveredNode: FlamegraphFrame | null = null;
    const queue = [...this.roots];

    while (queue.length && !hoveredNode) {
      const frame = queue.pop()!;

      // We treat entire flamegraph as a segment tree, this allows us to query in O(log n) time by
      // only looking at the nodes that are relevant to the current cursor position. We discard any values
      // on x axis that do not overlap the cursor, and descend until we find a node that overlaps at cursor y position
      if (configSpaceCursor[0] < frame.start || configSpaceCursor[0] > frame.end) {
        continue;
      }

      // If our frame depth overlaps cursor y position, we have found our node
      if (
        configSpaceCursor[1] >= frame.depth &&
        configSpaceCursor[1] <= frame.depth + 1
      ) {
        hoveredNode = frame;
        break;
      }

      // Descend into the rest of the children
      for (let i = 0; i < frame.children.length; i++) {
        queue.push(frame.children[i]);
      }
    }
    return hoveredNode;
  }

  setSearchResults(searchResults: FlamegraphSearch['results']) {
    const matchedFrame = new Float32Array(6).fill(1);
    const unMatchedFrame = new Float32Array(6).fill(0);

    for (let i = 0; i < this.frames.length; i++) {
      this.searchResults.set(
        searchResults.has(getFlamegraphFrameSearchId(this.frames[i]))
          ? matchedFrame
          : unMatchedFrame,
        i * 6
      );
    }

    if (!this.program || !this.gl) {
      return;
    }

    const aIsSearchResult = this.gl.getAttribLocation(this.program, 'a_is_search_result');
    // attributes get data from buffers
    this.attributes.a_is_search_result = aIsSearchResult;

    // Init color buffer
    const searchResultsBuffer = this.gl.createBuffer();

    // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = searchResultsBuffer)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, searchResultsBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.searchResults, this.gl.DYNAMIC_DRAW);

    const size = 1;
    const type = this.gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = 0;

    this.gl.vertexAttribPointer(aIsSearchResult, size, type, normalize, stride, offset);
    // Point to attribute location
    this.gl.enableVertexAttribArray(aIsSearchResult);
  }

  draw(configViewToPhysicalSpace: mat3): void {
    if (!this.gl) {
      throw new Error('Uninitialized WebGL context');
    }

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    // We have no frames to draw
    if (!this.positions.length || !this.program) {
      return;
    }

    this.gl.useProgram(this.program);

    const projectionMatrix = makeProjectionMatrix(
      this.gl.canvas.width,
      this.gl.canvas.height
    );

    // Projection matrix
    this.gl.uniformMatrix3fv(this.uniforms.u_projection, false, projectionMatrix);

    // Model to projection
    this.gl.uniformMatrix3fv(this.uniforms.u_model, false, configViewToPhysicalSpace);

    // Check if we should draw border
    this.gl.uniform1i(this.uniforms.u_draw_border, this.options.draw_border ? 1 : 0);

    // Tell webgl to convert clip space to px
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);

    const physicalSpacePixel = new Rect(0, 0, 1, 1);
    const physicalToConfig = mat3.invert(mat3.create(), configViewToPhysicalSpace);
    const configSpacePixel = physicalSpacePixel.transformRect(physicalToConfig);

    this.gl.uniform2f(
      this.uniforms.u_border_width,
      configSpacePixel.width,
      configSpacePixel.height
    );

    const VERTICES = 6;
    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.frames.length * VERTICES);
  }
}

export {FlamegraphRenderer};
