function setup() {
  createCanvas(640, 480);
  colorMode(HSB, 360, 100, 100, 100);
}

function draw() {
  background(230, 35, 10, 18);
  translate(width / 2, height / 2);
  noStroke();
  for (let i = 0; i < 50; i++) {
    const angle = frameCount * 0.008 + i * TWO_PI / 36;
    const radius = 130 + sin(frameCount * 0.02 + i) * 55;
    fill((i * 10 + frameCount) % 360, 65, 95, 85);
    circle(cos(angle) * radius, sin(angle) * radius, 10);
  }
}
