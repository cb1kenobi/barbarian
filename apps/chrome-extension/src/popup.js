fetch('http://127.0.0.1:4142/api/health').then((response) => {
  if (!response.ok) throw new Error();
  document.querySelector('#status').className = 'ok';
  document.querySelector('#status').textContent = '● Local server connected';
}).catch(() => {
  document.querySelector('#status').className = 'bad';
  document.querySelector('#status').textContent = '● Local server is not running';
});
