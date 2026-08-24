fetch('/search-index.json').then(r=>r.json()).then(pages=>{
  const p = pages[Math.floor(Math.random()*pages.length)];
  if(p) location.href='/wiki/'+p.slug+'.html';
  else location.href='/';
});
