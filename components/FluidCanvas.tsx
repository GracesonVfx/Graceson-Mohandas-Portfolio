import React, { useEffect, useRef } from 'react';
import GUI from 'lil-gui';
import { SHADERS } from '../constants';

const params = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1024,
  DENSITY_DISSIPATION: 0.96, // Viscosity-ish
  VELOCITY_DISSIPATION: 0.98, // Flow persistence
  PRESSURE_ITERATIONS: 10,
  SPLAT_RADIUS: 0.002, // Fluid radius
  CURL: 30, // Vorticity (not yet implemented in shader but good placeholder)
  THRESHOLD: 0.0, // Edge threshold
  SOFTNESS: 0.5, // Edge softness
  COLOR: { r: 0.8, g: 0.5, b: 0.2 },
};

const FluidCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // --- WebGL Setup ---
    const gl = canvas.getContext('webgl');
    if (!gl) return;

    gl.getExtension('OES_texture_float');

    // --- Internal Types ---
    interface FBO {
      fbo: WebGLFramebuffer;
      width: number;
      height: number;
      texelSizeX: number;
      texelSizeY: number;
      attach: (id: number) => number;
    }

    interface DoubleFBO {
      width: number;
      height: number;
      texelSizeX: number;
      texelSizeY: number;
      read: () => FBO;
      write: () => FBO;
      swap: () => void;
    }

    // --- Helper Functions ---
    const createShader = (source: string, type: number) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const createProgram = (vertexSource: string, fragmentSource: string) => {
      const vShader = createShader(vertexSource, gl.VERTEX_SHADER);
      const fShader = createShader(fragmentSource, gl.FRAGMENT_SHADER);
      if (!vShader || !fShader) return null;

      const program = gl.createProgram();
      if (!program) return null;
      gl.attachShader(program, vShader);
      gl.attachShader(program, fShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        return null;
      }

      const uniforms: Record<string, WebGLUniformLocation> = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(program, i)!.name;
        uniforms[name] = gl.getUniformLocation(program, name)!;
      }
      return { program, uniforms };
    };

    const createFBO = (w: number, h: number, type = gl.RGBA): FBO => {
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, type, w, h, 0, type, gl.FLOAT, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        fbo: fbo!,
        width: w,
        height: h,
        texelSizeX: 1.0 / w,
        texelSizeY: 1.0 / h,
        attach(id) {
          gl.activeTexture(gl.TEXTURE0 + id);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          return id;
        },
      };
    };

    const createDoubleFBO = (w: number, h: number, type = gl.RGBA): DoubleFBO => {
      let fbo1 = createFBO(w, h, type);
      let fbo2 = createFBO(w, h, type);

      return {
        width: w,
        height: h,
        texelSizeX: 1.0 / w,
        texelSizeY: 1.0 / h,
        read: () => fbo1,
        write: () => fbo2,
        swap: () => {
          const temp = fbo1;
          fbo1 = fbo2;
          fbo2 = temp;
        },
      };
    };

    const getResolution = (resolution: number) => {
      let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
      if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
      const min = Math.round(resolution);
      const max = Math.round(resolution * aspectRatio);
      return gl.drawingBufferWidth > gl.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max };
    };

    const blit = (target: FBO | null) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
        gl.STATIC_DRAW
      );
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        new Uint16Array([0, 1, 2, 0, 2, 3]),
        gl.STATIC_DRAW
      );
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);

      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };

    // --- Init ---
    const splatProgram = createProgram(SHADERS.vertex, SHADERS.splat);
    const advectionProgram = createProgram(SHADERS.vertex, SHADERS.advection);
    const divergenceProgram = createProgram(SHADERS.vertex, SHADERS.divergence);
    const pressureProgram = createProgram(SHADERS.vertex, SHADERS.pressure);
    const gradientSubtractProgram = createProgram(SHADERS.vertex, SHADERS.gradientSubtract);
    const displayProgram = createProgram(SHADERS.vertex, SHADERS.display);

    if (
      !splatProgram ||
      !advectionProgram ||
      !divergenceProgram ||
      !pressureProgram ||
      !gradientSubtractProgram ||
      !displayProgram
    )
      return;

    let simRes = getResolution(params.SIM_RESOLUTION);
    let dyeRes = getResolution(params.DYE_RESOLUTION);

    let outputColor = createDoubleFBO(dyeRes.width, dyeRes.height);
    let velocity = createDoubleFBO(simRes.width, simRes.height);
    let divergence = createFBO(simRes.width, simRes.height, gl.RGB);
    let pressure = createDoubleFBO(simRes.width, simRes.height, gl.RGB);

    const pointer = {
      x: 0.65 * window.innerWidth,
      y: 0.5 * window.innerHeight,
      dx: 0,
      dy: 0,
      moved: false,
      firstMove: false,
    };

    // Auto-move initially
    setTimeout(() => {
      pointer.firstMove = true;
    }, 500); // Trigger sooner than 3000s for better UX

    let prevTimestamp = Date.now();
    let animId: number;

    const render = () => {
      const now = Date.now();
      const dt = (now - prevTimestamp) / 1000;
      prevTimestamp = now;

      if (!pointer.firstMove) {
        pointer.moved = true;
        const newX =
          (0.65 + 0.2 * Math.cos(0.006 * now) * Math.sin(0.008 * now)) *
          window.innerWidth;
        const newY =
          (0.5 + 0.12 * Math.sin(0.01 * now)) * window.innerHeight;
        pointer.dx = 10 * (newX - pointer.x);
        pointer.dy = 10 * (newY - pointer.y);
        pointer.x = newX;
        pointer.y = newY;
      }

      // Splat
      if (pointer.moved) {
        pointer.moved = false;

        gl.useProgram(splatProgram.program);
        gl.uniform1i(splatProgram.uniforms.u_input_txr, velocity.read().attach(0));
        gl.uniform1f(splatProgram.uniforms.u_ratio, canvas.width / canvas.height);
        gl.uniform2f(
          splatProgram.uniforms.u_point,
          pointer.x / canvas.width,
          1 - pointer.y / canvas.height
        );
        gl.uniform3f(splatProgram.uniforms.u_point_value, pointer.dx, -pointer.dy, 1);
        gl.uniform1f(splatProgram.uniforms.u_point_size, params.SPLAT_RADIUS); // Dynamic SPLAT_RADIUS
        blit(velocity.write());
        velocity.swap();

        gl.uniform1i(splatProgram.uniforms.u_input_txr, outputColor.read().attach(0));
        gl.uniform3f(
          splatProgram.uniforms.u_point_value,
          1.0 - params.COLOR.r,
          1.0 - params.COLOR.g,
          1.0 - params.COLOR.b
        );
        blit(outputColor.write());
        outputColor.swap();
      }

      // Divergence
      gl.useProgram(divergenceProgram.program);
      gl.uniform2f(
        divergenceProgram.uniforms.u_vertex_texel,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
      gl.uniform1i(divergenceProgram.uniforms.u_velocity_txr, velocity.read().attach(0));
      blit(divergence);

      // Pressure
      gl.useProgram(pressureProgram.program);
      gl.uniform2f(
        pressureProgram.uniforms.u_vertex_texel,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
      gl.uniform1i(pressureProgram.uniforms.u_divergence_txr, divergence.attach(0));
      for (let i = 0; i < params.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.u_pressure_txr, pressure.read().attach(1));
        blit(pressure.write());
        pressure.swap();
      }

      // Gradient Subtract
      gl.useProgram(gradientSubtractProgram.program);
      gl.uniform2f(
        gradientSubtractProgram.uniforms.u_vertex_texel,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
      gl.uniform1i(gradientSubtractProgram.uniforms.u_pressure_txr, pressure.read().attach(0));
      gl.uniform1i(gradientSubtractProgram.uniforms.u_velocity_txr, velocity.read().attach(1));
      blit(velocity.write());
      velocity.swap();

      // Advection (Velocity)
      gl.useProgram(advectionProgram.program);
      gl.uniform2f(
        advectionProgram.uniforms.u_vertex_texel,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
      gl.uniform2f(
        advectionProgram.uniforms.u_output_textel,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
      gl.uniform1i(advectionProgram.uniforms.u_velocity_txr, velocity.read().attach(0));
      gl.uniform1i(advectionProgram.uniforms.u_input_txr, velocity.read().attach(0));
      gl.uniform1f(advectionProgram.uniforms.u_dt, dt);
      gl.uniform1f(advectionProgram.uniforms.u_dissipation, params.VELOCITY_DISSIPATION);
      blit(velocity.write());
      velocity.swap();

      // Advection (Dye)
      gl.uniform2f(
        advectionProgram.uniforms.u_output_textel,
        outputColor.texelSizeX,
        outputColor.texelSizeY
      );
      gl.uniform1i(advectionProgram.uniforms.u_velocity_txr, velocity.read().attach(0));
      gl.uniform1i(advectionProgram.uniforms.u_input_txr, outputColor.read().attach(1));
      gl.uniform1f(advectionProgram.uniforms.u_dissipation, params.DENSITY_DISSIPATION);
      blit(outputColor.write());
      outputColor.swap();

      gl.useProgram(displayProgram.program);
      gl.uniform1i(displayProgram.uniforms.u_output_texture, outputColor.read().attach(0));
      gl.uniform1i(displayProgram.uniforms.u_overlay_texture, 2);
      gl.uniform1i(displayProgram.uniforms.u_overlay_depth, 3);
      gl.uniform1i(displayProgram.uniforms.u_bg_texture, 4);
      gl.uniform1i(displayProgram.uniforms.u_bg_depth, 5);
      
      gl.uniform2f(
        displayProgram.uniforms.u_mouse,
        pointer.x / canvas.width,
        1.0 - pointer.y / canvas.height
      );
      
      // Calculate UV scale for "cover" effect
      const screenAspect = canvas.width / canvas.height;
      let scaleX = 1.0;
      let scaleY = 1.0;
      
      if (screenAspect > overlayImageAspect) {
        // Screen is wider than image: match width, crop height
        scaleY = overlayImageAspect / screenAspect;
        // Wait, if screenAspect (2.0) > imageAspect (1.0).
        // scaleY should be less than 1 to "zoom in" on texture Y?
        // ShaderRecap: uv = (vUv - 0.5) * scale + 0.5
        // If scaleY is 0.5, then uv.y goes from 0.25 to 0.75 (center crop).
        // Yes, this is correct.
      } else {
        // Screen is taller than image: match height, crop width
        scaleX = screenAspect / overlayImageAspect;
      }
      
      gl.uniform2f(displayProgram.uniforms.u_uvScale, scaleX, scaleY);
      
      gl.uniform1f(displayProgram.uniforms.u_threshold, params.THRESHOLD);
      gl.uniform1f(displayProgram.uniforms.u_softness, params.SOFTNESS);

      blit(null);

      animId = requestAnimationFrame(render);
    };

    // --- GUI ---
    const gui = new GUI();
    gui.add(params, 'DENSITY_DISSIPATION', 0.9, 1.0).name('Viscosity');
    gui.add(params, 'VELOCITY_DISSIPATION', 0.9, 1.0).name('Flow Persistence');
    gui.add(params, 'PRESSURE_ITERATIONS', 0, 30).name('Pressure Iterations');
    gui.add(params, 'SPLAT_RADIUS', 0.001, 0.05).name('Fluid Radius');
    // gui.add(params, 'CURL', 0, 50).name('Curl'); // Not active yet
    gui.add(params, 'THRESHOLD', 0.0, 1.0).name('Edge Threshold');
    gui.add(params, 'SOFTNESS', 0.001, 1.0).name('Edge Softness');
    gui.addColor(params, 'COLOR').name('Fluid Color');
    const updateSize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      // Ideally resize FBOs here, but for now we rely on initial size
      // A full resize implementation would require destroying and recreating FBOs
    };

    const handleMouseMove = (e: MouseEvent) => {
      pointer.moved = true;
      pointer.dx = 5 * (e.pageX - pointer.x);
      pointer.dy = 5 * (e.pageY - pointer.y);
      pointer.x = e.pageX;
      pointer.y = e.pageY;
      pointer.firstMove = true;
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      pointer.moved = true;
      const touch = e.targetTouches[0];
      pointer.dx = 8 * (touch.pageX - pointer.x);
      pointer.dy = 8 * (touch.pageY - pointer.y);
      pointer.x = touch.pageX;
      pointer.y = touch.pageY;
      pointer.firstMove = true;
    };

    const handleClick = (e: MouseEvent) => {
      pointer.dx = 10;
      pointer.dy = 10;
      pointer.x = e.pageX;
      pointer.y = e.pageY;
      pointer.firstMove = true;
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('click', handleClick);

    let overlayImageAspect = 1.0;
    
    // Helper to load texture
    const loadTexture = (src: string, unit: number) => {
        const texture = gl.createTexture();
        const image = new Image();
        image.onload = () => {
            if (unit === 2) overlayImageAspect = image.width / image.height; // Capture aspect from overlay
            
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        };
        image.src = src;
        return texture;
    };

    // Load all 4 textures
    // Unit 2: Overlay Color
    loadTexture("/Assests/rdj.jpeg", 2);
    // Unit 3: Overlay Depth
    loadTexture("/Assests/rdj_depthmap.jpeg", 3);
    // Unit 4: BG Color
    loadTexture("https://i.ibb.co/tpshN65M/Ironmansuit.png", 4);
    // Unit 5: BG Depth
    loadTexture("/Assests/ironmansuit_depth.png", 5);

    render();

    return () => {
      window.removeEventListener('resize', updateSize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('click', handleClick);
      cancelAnimationFrame(animId);
      gui.destroy();
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 w-full h-full block z-10" />;
};

export default FluidCanvas;