const button = document.getElementById("request-backend") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLOutputElement;
const apiPort = new URLSearchParams(window.location.search).get("api_port");

if (!apiPort) {
  throw new Error("fullstack fixture requires an api_port query parameter");
}

const requestUrl = `http://127.0.0.1:${apiPort}/api/x`;

button.addEventListener("click", async () => {
  result.textContent = "loading";
  const response = await fetch(requestUrl); // L3 breakpoint target (fullstack-flow:13)
  const payload = (await response.json()) as { message: string; requestPath: string };
  result.textContent = `${payload.message}:${payload.requestPath}`;
});
