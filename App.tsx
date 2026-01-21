import React from 'react';
import FluidCanvas from './components/FluidCanvas';

const App: React.FC = () => {
  return (
    <div className="relative w-full h-screen overflow-hidden bg-black">
      {/* 
        1. Content: The image to be revealed.
           Positioned absolutely in the center.
      */}


      {/* 
        2. Canvas: The fluid overlay.
           Z-Index 10 ensures it covers the image. The shader makes it transparent where fluid flows.
      */}
      <FluidCanvas />

      {/* 
        3. Overlay Text: Sits on top of everything.
      */}
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-20 mix-blend-difference text-white">
        <h1 className="text-6xl md:text-9xl font-bold tracking-tighter uppercase text-center opacity-80 select-none">
          
        </h1>
      </div>
    </div>
  );
};

export default App;