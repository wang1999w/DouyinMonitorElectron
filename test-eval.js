(function(){
  var noteId="69fefd0f0000000035028cb4";
  var links = document.querySelectorAll('a[href*="/search_result/'+noteId+'"], a[href*="/explore/'+noteId+'"]');
  for(var i=0;i<links.length;i++){
    var a = links[i];
    if(a.offsetWidth > 30 && a.offsetHeight > 30){
      a.click();
      return 'clicked: ' + a.className + ' href=' + (a.getAttribute('href')||'').substring(0,50);
    }
  }
  return 'no clickable link found';
})()
