import * as THREE from './vendor/three.module.js';

export function startScene(theme) {
  const mount = document.querySelector('#scene');
  const renderer = new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.setClearColor(0,0);
  mount.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34,1,.1,80);
  camera.position.set(0,3.6,11.5);
  camera.lookAt(0,.35,0);
  const world = new THREE.Group();scene.add(world);
  scene.add(new THREE.HemisphereLight(0xffffff,theme==='orbit'?0x5e5088:0xa4a399,2.8));
  const key = new THREE.DirectionalLight(0xfffaf0,4.5);
  key.position.set(-3,7,5);key.castShadow = true;
  key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-6;key.shadow.camera.right=6;key.shadow.camera.top=6;key.shadow.camera.bottom=-6;
  key.shadow.normalBias=.025;key.shadow.bias=-.0002;key.shadow.radius=5;scene.add(key);
  const fill = new THREE.DirectionalLight(theme==='orbit'?0xb6a6ff:0xc2d8ff,2.4);fill.position.set(5,3,-3);scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff,1.5);rim.position.set(0,3,-5);scene.add(rim);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(25,25),new THREE.ShadowMaterial({opacity:theme==='orbit'?.08:.13}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-1.85;ground.receiveShadow=true;scene.add(ground);
  const moving = [];
  const material = (color,roughness=.38) => new THREE.MeshStandardMaterial({color,roughness,metalness:0});
  const mesh = (geometry,mat) => {const m=new THREE.Mesh(geometry,mat);m.castShadow=true;m.receiveShadow=true;return m;};
  function roundedGeometry(w,h,d,r=.15) {
    r=Math.min(r,w/2-.001,h/2-.001,d/2-.001);
    const shape=new THREE.Shape();const x=-w/2,y=-h/2;
    shape.moveTo(x+r,y);shape.lineTo(x+w-r,y);shape.quadraticCurveTo(x+w,y,x+w,y+r);
    shape.lineTo(x+w,y+h-r);shape.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    shape.lineTo(x+r,y+h);shape.quadraticCurveTo(x,y+h,x,y+h-r);
    shape.lineTo(x,y+r);shape.quadraticCurveTo(x,y,x+r,y);
    const g = new THREE.ExtrudeGeometry(shape,{depth:d-2*r,bevelEnabled:true,bevelSegments:5,steps:1,bevelSize:r,bevelThickness:r,curveSegments:10});
    g.center();return g;
  }
  const box = (w,h,d,color,r=.13) => mesh(roundedGeometry(w,h,d,r),material(color));
  function float(object,position,rotation=[0,0,0],speed=.65,amplitude=.09) {
    object.position.set(...position);object.rotation.set(...rotation);world.add(object);
    moving.push({object,position:object.position.clone(),rotation:object.rotation.clone(),speed,amplitude,phase:moving.length*1.7});return object;
  }
  function texture(text,color='#304237',background=null,size=512) {
    const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
    const ctx=canvas.getContext('2d');
    if(background){ctx.fillStyle=background;ctx.fillRect(0,0,size,size);}
    ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`800 ${size*.62}px Preview, sans-serif`;ctx.fillText(text,size/2,size*.52);
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;return map;
  }
  function tile(word,color,size=1,ink='#2d4238') {
    const group=new THREE.Group();group.add(box(size,size,.42*size,color,.13*size));
    const text=mesh(new THREE.PlaneGeometry(size*.88,size*.88),new THREE.MeshBasicMaterial({map:texture(word,ink),transparent:true,depthWrite:false}));
    text.position.z=size*.215+.05;group.add(text);return group;
  }
  function star(color,size=.5) {
    const shape=new THREE.Shape();
    for(let i=0;i<10;i++){const angle=Math.PI/2+i*Math.PI/5;const radius=i%2?size*.5:size;const x=Math.cos(angle)*radius,y=Math.sin(angle)*radius;i?shape.lineTo(x,y):shape.moveTo(x,y);}shape.closePath();
    const g=new THREE.ExtrudeGeometry(shape,{depth:.13,bevelEnabled:true,bevelSegments:5,bevelSize:.075,bevelThickness:.075,steps:1});g.center();return mesh(g,material(color));
  }
  function sphere(color,radius) {return mesh(new THREE.SphereGeometry(radius,48,32),material(color,.27));}
  function smile(parent,radius,color='#314339') {
    const group=new THREE.Group();const mat=material(color,.65);
    for(const x of [-.20,.20]){const eye=mesh(new THREE.SphereGeometry(.055,16,16),mat);eye.scale.y=1.35;eye.position.set(x*radius,.10*radius,radius*.96);group.add(eye);}
    const curve=new THREE.EllipseCurve(0,-.04*radius,.18*radius,.16*radius,Math.PI*1.12,Math.PI*1.88,false,0);
    const pts=curve.getPoints(32).map(p=>new THREE.Vector3(p.x,p.y,radius*.985));
    const mouth=mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),32,.02*radius,8,false),mat);group.add(mouth);parent.add(group);
  }
  function book(color='#729d83') {
    const group=new THREE.Group();
    // Two sculpted halves, paper layers and a curved printed spread.
    for(const side of [-1,1]){
      const cover=box(1.74,.12,2.43,color,.045);cover.position.set(side*.89,-.02,0);cover.rotation.z=side*.035;group.add(cover);
      const paper=box(1.65,.24,2.29,'#f4f1de',.045);paper.position.set(side*.87,.13,0);group.add(paper);
      for(let k=0;k<4;k++){
        const line=box(1.61,.012,2.27,k%2?'#dddcca':'#fffef1',.003);line.position.set(side*.87,.06+k*.052,.005);group.add(line);
      }
      const geometry=new THREE.PlaneGeometry(1,1,36,16);const pos=geometry.attributes.position;
      for(let i=0;i<pos.count;i++){
        const u=pos.getX(i)+.5,v=pos.getY(i)+.5;
        pos.setXYZ(i,side*(.03+u*1.68),.31+Math.sin(u*Math.PI)*.24-u*.04,(v-.5)*2.27);
      }
      const uv=geometry.attributes.uv;
      for(let i=0;i<uv.count;i++)uv.setXY(i,side===-1?1-uv.getX(i):uv.getX(i),1-uv.getY(i));
      geometry.computeVertexNormals();
      const pageCanvas=document.createElement('canvas');pageCanvas.width=512;pageCanvas.height=640;const ctx=pageCanvas.getContext('2d');
      ctx.fillStyle='#fffef3';ctx.fillRect(0,0,512,640);ctx.fillStyle=side===1?'#90a68a':'#cbcdb6';
      if(side===1){ctx.font='800 120px Preview';ctx.textAlign='center';ctx.fillText('우리말',256,235);ctx.fillStyle='#cbd3b8';ctx.fillRect(100,285,310,8);ctx.fillRect(100,325,265,8);ctx.fillRect(100,365,290,8);}
      else{ctx.fillStyle='#dce4d1';ctx.beginPath();ctx.arc(260,240,112,0,Math.PI*2);ctx.fill();ctx.fillStyle='#74916d';ctx.font='800 90px Preview';ctx.textAlign='center';ctx.fillText('말',260,272);ctx.fillStyle='#d4d9c3';ctx.fillRect(110,425,290,8);ctx.fillRect(110,465,250,8);}
      const map=new THREE.CanvasTexture(pageCanvas);map.colorSpace=THREE.SRGBColorSpace;
      const surface=mesh(geometry,new THREE.MeshStandardMaterial({map,roughness:.8,side:THREE.DoubleSide}));group.add(surface);
    }
    const spine=box(.1,.20,2.45,color,.025);spine.position.y=.04;group.add(spine);
    const bookmark=box(.18,.028,.7,'#e8b66a',.012);bookmark.position.set(.5,.02,1.28);group.add(bookmark);
    return group;
  }
  function torus(radius,tube,color,arc=Math.PI*2){return mesh(new THREE.TorusGeometry(radius,tube,20,100,arc),material(color,.3));}
  if(theme==='atelier'){
    camera.position.set(0,4.2,11.7);camera.lookAt(0,.2,0);
    const openBook=book();openBook.scale.setScalar(1.15);float(openBook,[.1,-.65,.2],[.10,-.37,-.10],.48,.08);
    float(tile('꿈','#d0c4e9',.93,'#665879'),[-1.67,1.39,.10],[-.10,-.30,-.19],.65,.12);
    float(tile('쉼','#e8bd9c',.86,'#815848'),[1.74,.94,-.25],[.04,-.40,.20],.72,.16);
    float(star('#edcb73',.51),[.3,2.0,-.65],[0,-.28,-.12],.8,.10);
    const friend=sphere('#b6cdb4',.44);smile(friend,.44);float(friend,[-1.84,-.15,.92],[-.1,.12,-.1],.7,.12);
    float(sphere('#c6bacf',.16),[1.92,-.32,.6],[0,0,0],.9,.11);
    float(sphere('#dfd8ba',.12),[-.87,2.15,-.3],[0,0,0],.65,.13);
    const littleRing=torus(.24,.067,'#b0bfa0');float(littleRing,[1.5,1.97,-.7],[.4,.1,-.3],.65,.08);
  }else if(theme==='orbit'){
    camera.position.set(0,1.6,12.9);camera.lookAt(0,.12,0);
    renderer.toneMappingExposure=1.05;
    const planet=new THREE.Group();planet.add(sphere('#a899df',1.15));smile(planet,1.15,'#433660');
    const belt=torus(1.72,.095,'#ded9f2');belt.rotation.set(1.14,.22,-.35);planet.add(belt);
    const outer=torus(2.05,.014,'#77709f');outer.rotation.set(1.14,.22,-.35);planet.add(outer);
    float(planet,[0,.12,-.4],[-.12,-.15,-.13],.46,.11);
    float(tile('말','#d5eea3',.90,'#536447'),[-2.25,.85,.4],[-.12,-.36,-.2],.55,.16);
    float(tile('꿈','#e9bbcd',.76,'#875d75'),[1.92,1.19,.2],[.10,-.37,.15],.65,.14);
    const miniBook=book('#aaa4d1');miniBook.scale.setScalar(.35);float(miniBook,[1.8,-1.25,.1],[.5,.15,.2],.65,.1);
    float(star('#d9edac',.27),[-1.4,-1.24,.5],[.15,.3,-.2],.8,.12);
    float(sphere('#8c82b1',.15),[.7,1.95,-.4],[0,0,0],.65,.11);
    float(sphere('#f3dba6',.12),[-2.2,-.55,.1],[0,0,0],.75,.14);
    float(star('#b6afe1',.18),[2.85,-.37,-.7],[.15,.3,.1],.7,.08);
  }else{
    camera.position.set(0,3.1,12.2);camera.lookAt(0,.45,0);
    const base=new THREE.Group();
    const platform=mesh(new THREE.CylinderGeometry(2.05,2.10,.16,96),material('#e4e6e6',.6));platform.position.y=-1.4;base.add(platform);world.add(base);
    const main=tile('말','#4e62ee',1.65,'#f5f3ee');float(main,[-.18,-.40,.25],[.02,-.30,-.12],.55,.045);
    float(tile('꿈','#d9ef8e',1.05,'#4c6335'),[-1.03,1.05,-.15],[-.05,.20,-.21],.6,.07);
    const coral=new THREE.Group();const pill=mesh(new THREE.CapsuleGeometry(.42,.85,12,32),material('#f2a691'));coral.add(pill);smile(coral,.42,'#855345');float(coral,[1.45,.55,.10],[.10,0,-.27],.75,.1);
    const arch=torus(1.22,.19,'#99adf0',Math.PI*1.48);float(arch,[.15,.78,-.85],[.18,-.12,-.15],.5,.05);
    float(star('#e0ea98',.43),[1.23,1.91,-.1],[0,-.25,.1],.7,.12);
    float(sphere('#f1b79e',.19),[-1.75,-.6,.4],[0,0,0],.7,.11);
    const tiny=tile('쉼','#e2d8ea',.6,'#796585');float(tiny,[1.0,-1.0,1.0],[-.10,-.1,.20],.65,.07);
  }
  let width=0,height=0;
  const resize=()=>{width=mount.clientWidth;height=mount.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();};
  const observer=new ResizeObserver(resize);observer.observe(mount);resize();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');let paused=reduced.matches,visible=true,elapsed=0,last=performance.now();
  const control=document.querySelector('.motion-control');
  function updateControl(){control.textContent=paused?'▷':'Ⅱ';control.setAttribute('aria-label',paused?'3D 움직임 재생':'3D 움직임 멈추기');control.setAttribute('aria-pressed',String(paused));}
  updateControl();control.onclick=()=>{paused=!paused;updateControl();};
  reduced.addEventListener('change',event=>{paused=event.matches;updateControl();});
  const pointer={x:0,y:0};mount.addEventListener('pointermove',event=>{const r=mount.getBoundingClientRect();pointer.x=(event.clientX-r.left)/r.width-.5;pointer.y=(event.clientY-r.top)/r.height-.5;},{passive:true});
  mount.addEventListener('pointerleave',()=>{pointer.x=0;pointer.y=0;});
  const visibility=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;},{threshold:0});visibility.observe(mount);
  window.addEventListener('message',event=>{if(event.origin!==location.origin)return;if(event.data?.type==='preview-motion'){paused=Boolean(event.data.paused);updateControl();}});
  document.addEventListener('visibilitychange',()=>{last=performance.now();});
  function animate(now){requestAnimationFrame(animate);const delta=Math.min((now-last)/1000,.06);last=now;if(document.hidden||!visible)return;if(!paused)elapsed+=delta;
    for(const item of moving){const t=elapsed*item.speed+item.phase;item.object.position.y=item.position.y+Math.sin(t)*item.amplitude;item.object.rotation.y=item.rotation.y+Math.sin(t*.6)*.10;item.object.rotation.z=item.rotation.z+Math.sin(t*.7)*.035;}
    if(!paused){world.rotation.y+=(pointer.x*.14-world.rotation.y)*.035;world.rotation.x+=(-pointer.y*.07-world.rotation.x)*.035;}
    renderer.render(scene,camera);
  }
  renderer.render(scene,camera);document.body.dataset.scene='ready';requestAnimationFrame(animate);
  window.addEventListener('pagehide',()=>{observer.disconnect();visibility.disconnect();renderer.dispose();},{once:true});
}
