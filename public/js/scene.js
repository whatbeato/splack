import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const dataEl = document.getElementById('graph-data');
const emptyState = document.getElementById('empty-state');
const data = JSON.parse(dataEl.textContent || '{"galaxies":[]}');
const galaxies = data.galaxies || [];

if (!galaxies.length) {
  emptyState.hidden = false;
} else {
  init(galaxies);
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function colorFor(str, s, l) {
  const hue = hashString(str) % 360;
  return new THREE.Color(`hsl(${hue}, ${s}%, ${l}%)`);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabelSprite(text, color) {
  const fontSize = 42;
  const padding = 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `600 ${fontSize}px "Segoe UI", sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + padding * 2;
  const height = fontSize + padding * 2;
  canvas.width = width;
  canvas.height = height;

  ctx.font = `600 ${fontSize}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(2, 1, 10, 0.55)';
  roundRect(ctx, 0, 0, width, height, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const scale = 0.045;
  sprite.scale.set(width * scale, height * scale, 1);
  return sprite;
}

function fibonacciPoint(index, total, radius) {
  if (total <= 1) return new THREE.Vector3(0, 0, 0);
  const offset = 2 / total;
  const increment = Math.PI * (3 - Math.sqrt(5));
  const y = index * offset - 1 + offset / 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = index * increment;
  const x = Math.cos(phi) * r;
  const z = Math.sin(phi) * r;
  return new THREE.Vector3(x * radius, y * radius * 0.5, z * radius);
}

function buildStarfield(scene, radius) {
  const starCount = 2400;
  const positions = new Float32Array(starCount * 3);
  const spread = radius * 4 + 800;

  for (let i = 0; i < starCount; i += 1) {
    const r = spread * 0.4 + Math.random() * spread * 0.6;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.75,
  });
  scene.add(new THREE.Points(geometry, material));
}

function init(galaxyData) {
  const container = document.getElementById('scene-container');
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02010a, 0.0009);

  const galaxyRadius = Math.max(120, galaxyData.length * 25);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 8000);
  camera.position.set(0, galaxyRadius * 0.6, galaxyRadius * 1.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 40;
  controls.maxDistance = galaxyRadius * 6;

  scene.add(new THREE.AmbientLight(0x8888ff, 0.5));
  const keyLight = new THREE.PointLight(0xffffff, 1.4, 0, 0);
  keyLight.position.set(0, galaxyRadius, galaxyRadius * 0.5);
  scene.add(keyLight);

  buildStarfield(scene, galaxyRadius);

  const interactive = [];
  const galaxyGroups = [];

  galaxyData.forEach((galaxy, gIndex) => {
    const center = fibonacciPoint(gIndex, galaxyData.length, galaxyRadius);
    const galaxyGroup = new THREE.Group();
    galaxyGroup.position.copy(center);
    scene.add(galaxyGroup);
    galaxyGroups.push(galaxyGroup);

    const galaxyColor = colorFor(galaxy.name, 70, 62);
    const planetCount = galaxy.planets.length;
    const countLabel = `${planetCount} planet${planetCount === 1 ? '' : 's'}`;

    const hub = new THREE.Mesh(
      new THREE.SphereGeometry(9, 24, 24),
      new THREE.MeshStandardMaterial({
        color: galaxyColor,
        emissive: galaxyColor,
        emissiveIntensity: 0.6,
        roughness: 0.35,
        metalness: 0.2,
      })
    );
    hub.userData = {
      kind: 'galaxy',
      title: galaxy.name,
      detail: galaxy.channel ? `#${galaxy.channel} · ${countLabel}` : countLabel,
      baseScale: 1,
    };
    galaxyGroup.add(hub);
    interactive.push(hub);

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(14, 16, 16),
      new THREE.MeshBasicMaterial({ color: galaxyColor, transparent: true, opacity: 0.18 })
    );
    galaxyGroup.add(glow);

    const label = makeLabelSprite(galaxy.name, '#e8e6ff');
    label.position.set(0, 20, 0);
    galaxyGroup.add(label);

    const orbitBaseRadius = 20;
    const orbitGap = 11;
    const tilt = ((gIndex % 5) - 2) * 0.12;

    galaxy.planets.forEach((planet, pIndex) => {
      const orbitGroup = new THREE.Group();
      orbitGroup.rotation.x = tilt;
      orbitGroup.userData.spinSpeed = 0.06 + (pIndex % 5) * 0.015 + gIndex * 0.001;
      orbitGroup.userData.phase = Math.random() * Math.PI * 2;
      galaxyGroup.add(orbitGroup);

      const orbitRadius = orbitBaseRadius + pIndex * orbitGap;

      const ringPoints = Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * orbitRadius, 0, Math.sin(a) * orbitRadius);
      });
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ringPoints),
        new THREE.LineBasicMaterial({ color: galaxyColor, transparent: true, opacity: 0.25 })
      );
      orbitGroup.add(ring);

      const planetColor = colorFor(planet.owner || planet.name, 65, 68);
      const planetMesh = new THREE.Mesh(
        new THREE.SphereGeometry(4.2, 20, 20),
        new THREE.MeshStandardMaterial({ color: planetColor, roughness: 0.6, metalness: 0.1 })
      );
      planetMesh.position.set(orbitRadius, 0, 0);
      planetMesh.userData = {
        kind: 'planet',
        title: planet.name,
        detail: planet.owner ? `in ${galaxy.name} · claimed by ${planet.owner}` : `in ${galaxy.name} · unclaimed`,
        baseScale: 1,
      };
      orbitGroup.add(planetMesh);
      interactive.push(planetMesh);

      const planetLabel = makeLabelSprite(planet.name, '#c9c6f5');
      planetLabel.position.set(orbitRadius, 7, 0);
      orbitGroup.add(planetLabel);

      const spoke = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(orbitRadius, 0, 0)]),
        new THREE.LineBasicMaterial({ color: galaxyColor, transparent: true, opacity: 0.35 })
      );
      orbitGroup.add(spoke);
    });
  });

  if (galaxyGroups.length > 1) {
    const webMaterial = new THREE.LineBasicMaterial({ color: 0x4a4680, transparent: true, opacity: 0.15 });
    galaxyGroups.forEach((group, i) => {
      const next = galaxyGroups[(i + 1) % galaxyGroups.length];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([group.position.clone(), next.position.clone()]),
        webMaterial
      );
      scene.add(line);
    });
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selected = null;

  const panel = document.getElementById('info-panel');
  const panelKind = document.getElementById('info-kind');
  const panelTitle = document.getElementById('info-title');
  const panelDetail = document.getElementById('info-detail');

  function resetSelection(mesh) {
    mesh.scale.setScalar(mesh.userData.baseScale);
  }

  document.getElementById('info-panel-close').addEventListener('click', () => {
    panel.hidden = true;
    if (selected) resetSelection(selected);
    selected = null;
  });

  renderer.domElement.addEventListener('click', (event) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(interactive, false);

    if (!hits.length) return;

    if (selected) resetSelection(selected);

    const mesh = hits[0].object;
    selected = mesh;
    mesh.scale.setScalar(1.6);

    panelKind.textContent = mesh.userData.kind;
    panelTitle.textContent = mesh.userData.title;
    panelDetail.textContent = mesh.userData.detail;
    panel.hidden = false;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();

    galaxyGroups.forEach((group) => {
      group.children.forEach((child) => {
        if (child.userData && typeof child.userData.spinSpeed === 'number') {
          child.rotation.y = elapsed * child.userData.spinSpeed + (child.userData.phase || 0);
        }
      });

      const hub = group.children.find((c) => c.userData && c.userData.kind === 'galaxy');
      if (hub && hub !== selected) {
        const pulse = 1 + Math.sin(elapsed * 1.5 + group.position.x) * 0.08;
        hub.scale.setScalar(pulse);
      }
    });

    controls.update();
    renderer.render(scene, camera);
  }

  animate();
}
