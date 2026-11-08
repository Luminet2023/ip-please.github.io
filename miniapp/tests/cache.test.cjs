const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('website build invalidates old warm script URLs uniformly including the host',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const scripts=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]);
 const warm=new Set(scripts.map(s=>s.startsWith('game-host.js')?'game-host.js':s.split('?')[0]+'?v=20261024-4'));
 const build=require('../../tools/test_runtime')(17).run('BUILD_VERSION');const expected=build.replace(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/,'$1$2$3-$4');
 assert.ok(scripts.length>15);for(const src of scripts){assert.equal(warm.has(src),false,'warm cache must miss '+src);assert.equal(new URL(src,'https://game.test').searchParams.get('v'),expected);}
});
