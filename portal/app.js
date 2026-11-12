let version=1;let dimensions=['museum','zone','date'];let expanded=new Set();
const leaves=[{path:['甲馆','A区','2026-11-13'],value:'12',state:'value'},{path:['甲馆','A区','2026-11-14'],value:'0',state:'value'},{path:['甲馆','B区','2026-11-13'],value:'—',state:'suppressed'},{path:['乙馆','A区','2026-11-13'],value:'',state:'missing'}];
function render(){
  const originalDimensions=['museum','zone','date'];
  const firstDimension=dimensions[0];
  const rootIndex=originalDimensions.indexOf(firstDimension);
  const roots=[...new Set(leaves.map(row=>row.path[rootIndex]))];
  let html=`<h1>经营透视</h1><button id="refresh">刷新数据版</button><button id="dimensions">重排维度</button><section data-query="all" data-generation="${version}" data-dimensions="${dimensions.join(',')}"><p data-pivot-row data-key="total" data-version="${version}" data-grain="total">总计24</p>`;
  for(const root of roots){
    html+=`<div data-pivot-row data-key="${root}" data-version="${version}" data-grain="${firstDimension}"><button data-expand="${root}">${expanded.has(root)?'折叠':'展开'}</button>${root}小计</div>`;
    if(expanded.has(root))for(const row of leaves.filter(item=>item.path[rootIndex]===root)){
      const displayPath=dimensions.map(dimension=>row.path[originalDimensions.indexOf(dimension)]);
      html+=`<p data-pivot-row data-key="${row.path.join('/')}" data-version="${version}" data-grain="${dimensions.join(',')}" data-state="${row.state}" data-path='${JSON.stringify(displayPath)}'>${displayPath.join(' / ')}: ${row.value}</p>`;
    }
  }
  html+='<p data-coverage="top-n" data-remaining="2">仅显示前N项，另有2项不予展开</p></section>';
  document.querySelector('#app').innerHTML=html;
  document.querySelectorAll('[data-expand]').forEach(button=>button.onclick=async()=>{const key=button.dataset.expand;if(expanded.has(key))expanded.delete(key);else{button.disabled=true;button.textContent='加载中';await new Promise(resolve=>setTimeout(resolve,50));expanded.add(key);}render();});
  document.querySelector('#refresh').onclick=()=>{version++;expanded.clear();render();};
  document.querySelector('#dimensions').onclick=()=>{dimensions.reverse();version++;expanded.clear();render();};
  document.querySelector('#app').dataset.ready='true';persist();
}
let saving=Promise.resolve();let saveGeneration=0;
function persist(){const generation=++saveGeneration;const payload=JSON.stringify(({version,dimensions}));document.querySelector('#app').dataset.saved='false';saving=saving.then(()=>fetch('/state',{method:'POST',headers:{'content-type':'application/json'},body:payload})).then(response=>{if(!response.ok)throw Error('门户保存失败');if(generation===saveGeneration)document.querySelector('#app').dataset.saved='true';}).catch(error=>{document.querySelector('#status').textContent=error.message;});}
async function boot(){const saved=await(await fetch('/state')).json();if(saved){version=saved.version;dimensions=saved.dimensions;}render();}boot();
