import { codeToHtml } from 'shiki';

async function test() {
  const html = await codeToHtml('console.log("hello");', {
    lang: 'javascript',
    theme: 'vitesse-dark'
  });
  console.log(html);
}

test();
