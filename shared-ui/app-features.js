// shared-ui/app-features.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. Setup Particle Background
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.zIndex = '-1';
    canvas.style.pointerEvents = 'none';
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let width = canvas.width = window.innerWidth;
    let height = canvas.height = window.innerHeight;
    
    const particles = [];
    const particleCount = 45;

    for (let i = 0; i < particleCount; i++) {
        particles.push({
            x: Math.random() * width,
            y: Math.random() * height,
            radius: Math.random() * 2 + 0.5,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            alpha: Math.random() * 0.4 + 0.05
        });
    }

    function float() {
        ctx.clearRect(0, 0, width, height);
        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            
            // wrap around smoothly
            if (p.x < 0) p.x = width;
            if (p.x > width) p.x = 0;
            if (p.y < 0) p.y = height;
            if (p.y > height) p.y = 0;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            // Light theme pastel purple for particles
            ctx.fillStyle = `rgba(162, 155, 254, ${p.alpha})`;
            ctx.fill();
        });
        requestAnimationFrame(float);
    }
    float();

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
    });

    // 2. System Health Badge
    const badge = document.createElement('div');
    badge.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 8px; height: 8px; background: #00b894; border-radius: 50%; box-shadow: 0 0 8px #00b894; animation: badge-blink 2s infinite;"></div>
            <span>System: Optimal</span>
        </div>
    `;
    badge.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.5);
        padding: 10px 18px;
        border-radius: 30px;
        font-size: 0.85rem;
        color: #2d3436;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        pointer-events: none;
        z-index: 1000;
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.08);
    `;
    document.body.appendChild(badge);

    const style = document.createElement('style');
    style.innerHTML = `@keyframes badge-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`;
    document.head.appendChild(style);
});
