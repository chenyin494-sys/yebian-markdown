const esbuild=require('esbuild');
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'../extension');
(async()=>{
  const result=await esbuild.build({entryPoints:[path.join(root,'editor-source.js')],outfile:path.join(root,'vendor/rich-editor.js'),bundle:true,format:'esm',minify:true,metafile:true,legalComments:'external',nodePaths:[path.resolve(__dirname,'../node_modules')]});
  const packages=new Set();
  for(const file of Object.keys(result.metafile.inputs)) {
    if(!file.includes('node_modules/'))continue;
    let dir=path.dirname(path.resolve(file));
    while(dir!==path.dirname(dir) && !fs.existsSync(path.join(dir,'package.json')))dir=path.dirname(dir);
    if(fs.existsSync(path.join(dir,'package.json')))packages.add(dir);
  }
  const dir=path.join(root,'vendor/licenses');fs.mkdirSync(dir,{recursive:true});
  const versions=[];
  for(const pkg of packages) {
    const meta=JSON.parse(fs.readFileSync(path.join(pkg,'package.json'),'utf8'));
    versions.push(`${meta.name} ${meta.version}`);
    const license=fs.readdirSync(pkg).find(file=>/^licen[sc]e(?:\.|$)/i.test(file));
    if(license)fs.copyFileSync(path.join(pkg,license),path.join(dir,meta.name.replace(/[\/@]/g,'_')+'.txt'));
  }
  fs.writeFileSync(path.join(dir,'VERSIONS.txt'),versions.sort().join('\n')+'\n');
  console.log(`Rich editor bundled; ${packages.size} dependency records.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
