
// === PetController C+D Patch ===
// C: Unified character control API
// D: Lightweight canvas effects (breathing, pop)

(function(){
  if (typeof window === 'undefined') return;

  const PE = window.PetEngine;
  if (!PE) return;

  const PetController = {};

  // ---- C1: Unified APIs ----
  PetController.setExpression = function(state){
    PE.setExpression && PE.setExpression(state);
  };

  PetController.say = function(text){
    // hook point for bubble / chat UI
    try {
      document.dispatchEvent(new CustomEvent('pet:say', { detail: text }));
    } catch(e){}
  };

  PetController.setAccessory = function(slot, id){
    PE.setAccessory && PE.setAccessory(slot, id);
  };

  PetController.switchCharacter = function(id){
    if (!PE.loadCharacter) return;
    PE.loadCharacter(id);
    PE.loadEquipped && PE.loadEquipped();
    PE.setExpression && PE.setExpression('idle');
  };

  // ---- D1: Canvas Effects ----
  let breathPhase = 0;
  function breathing(){
    breathPhase += 0.02;
    const offset = Math.sin(breathPhase) * 0.6;
    if (PE.canvas){
      PE.canvas.style.transform = `translateY(${offset}px)`;
    }
    requestAnimationFrame(breathing);
  }

  PetController.startBreathing = function(){
    requestAnimationFrame(breathing);
  };

  PetController.pop = function(){
    if (!PE.canvas) return;
    PE.canvas.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(1.06)' },
      { transform: 'scale(1)' }
    ], { duration: 220, easing: 'ease-out' });
  };

  window.PetController = PetController;
})();
// === End Patch ===
