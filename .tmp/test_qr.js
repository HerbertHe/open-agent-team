async function run() {
  try {
    const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ local_token_list: [] })
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Keys:", Object.keys(data));
    for (const key of Object.keys(data)) {
      const val = data[key];
      console.log(`Key "${key}": type=${typeof val}, length=${String(val)?.length}, startWith=${String(val)?.substring(0, 100)}`);
    }
  } catch (err) {
    console.error(err);
  }
}
run();
