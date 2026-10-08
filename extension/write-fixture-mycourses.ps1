$ErrorActionPreference = 'Stop'
$root = 'E:\SIH\extension\SIH26\tests\fixtures'

$html = @'
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My courses - Synthetic portal</title><link rel="stylesheet" href="/portal.css"><link rel="stylesheet" href="/mycourses.css"></head>
<body class="mc-page">
  <header class="mc-navbar">
    <a class="mc-logo" href="/my-courses.html"><img src="/assets/logo.svg" width="28" height="28" alt="Portal logo">Portal</a>
    <nav class="mc-nav" aria-label="Primary">
      <a href="/index.html">Home</a><a href="/my-courses.html" aria-current="page">Dashboard</a><a href="/my-courses.html">My courses</a><a href="/my-courses.html">Messages</a>
    </nav>
    <a class="mc-profile" href="/my-courses.html">Profile</a>
  </header>
  <main class="mc-main">
    <nav class="mc-breadcrumb" aria-label="Breadcrumb">Home / Dashboard / My courses</nav>
    <h1 class="mc-title">My courses</h1>
    <p class="mc-sub">Course overview</p>
    <form class="mc-tools" aria-label="Search and filter">
      <input class="mc-search" type="search" placeholder="Search courses" aria-label="Search courses">
      <select class="mc-filter" aria-label="Filter"><option>All</option><option>In progress</option></select>
      <select class="mc-sort" aria-label="Sort"><option>Sort by A-Z</option><option>Sort by recent</option></select>
    </form>
    <section class="mc-cards">
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-1.svg" width="180" height="120" alt="CBE311 Database Security course thumbnail"></a><h2><a href="/page-b.html">CBE311 Database Security</a></h2><div class="mc-bar"><i style="width:64%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-2.svg" width="180" height="120" alt="CBE312 Internet of Things and Its Security course thumbnail"></a><h2><a href="/page-b.html">CBE312 Internet of Things and Its Security</a></h2><div class="mc-bar"><i style="width:42%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-3.svg" width="180" height="120" alt="CBS311 Fundamentals of Data Science course thumbnail"></a><h2><a href="/page-b.html">CBS311 Fundamentals of Data Science</a></h2><div class="mc-bar"><i style="width:88%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-4.svg" width="180" height="120" alt="CBS312 Introduction to Artificial Intelligence course thumbnail"></a><h2><a href="/page-b.html">CBS312 Introduction to Artificial Intelligence</a></h2><div class="mc-bar"><i style="width:12%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-5.svg" width="180" height="120" alt="EGS312 Distributed System Security course thumbnail"></a><h2><a href="/page-b.html">EGS312 Distributed System Security</a></h2><div class="mc-bar"><i style="width:55%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-6.svg" width="180" height="120" alt="EIS314 Financial Crime Motivations and Typologies course thumbnail"></a><h2><a href="/page-b.html">EIS314 Financial Crime Motivations and Typologies</a></h2><div class="mc-bar"><i style="width:30%"></i></div></article>
      <article class="mc-card"><a href="/page-b.html"><img class="mc-thumb" src="/assets/thumb-7.svg" width="180" height="120" alt="IMA313 Number Theory and Mathematical Theory of Coding course thumbnail"></a><h2><a href="/page-b.html">IMA313 Number Theory and Mathematical Theory of Coding</a></h2><div class="mc-bar"><i style="width:71%"></i></div></article>
    </section>
  </main>
  <footer class="mc-footer">Synthetic portal footer. No personal data on this page.</footer>
</body>
</html>
'@
[IO.File]::WriteAllText("$root\my-courses.html", $html)

$css = @'
body.mc-page { background:#f4f6fb; color:#182135; margin:0; font:15px/1.5 Arial, sans-serif; }
.mc-navbar { display:flex; align-items:center; gap:24px; background:#1d2b4f; color:#fff; padding:10px 20px; }
.mc-navbar a { color:#dbe4ff; text-decoration:none; font-weight:600; }
.mc-logo { display:flex; align-items:center; gap:8px; color:#fff !important; font-size:17px; }
.mc-nav { display:flex; gap:18px; }
.mc-profile { margin-left:auto; }
.mc-main { max-width:1100px; margin:0 auto; padding:20px 24px 40px; }
.mc-breadcrumb { color:#5a6b8c; font-size:13px; margin:8px 0 16px; }
.mc-title { margin:0 0 4px; font-size:30px; }
.mc-sub { color:#5a6b8c; margin:0 0 16px; }
.mc-tools { display:flex; gap:10px; margin-bottom:20px; }
.mc-search { flex:1; max-width:420px; padding:8px 12px; border:1px solid #c6d0e4; border-radius:6px; background:#fff; }
.mc-filter, .mc-sort { padding:8px 10px; border:1px solid #c6d0e4; border-radius:6px; background:#fff; }
.mc-cards { display:grid; grid-template-columns:repeat(2, 1fr); gap:18px; }
.mc-card { background:#fff; border:1px solid #dbe2f0; border-radius:10px; padding:16px; }
.mc-thumb { display:block; width:180px; height:120px; border-radius:6px; }
.mc-card h2 { font-size:16px; margin:10px 0 10px; }
.mc-card h2 a { color:#1d2b4f; text-decoration:none; }
.mc-bar { height:8px; background:#e6ebf5; border-radius:4px; }
.mc-bar i { display:block; height:8px; background:#2f6fed; border-radius:4px; }
.mc-footer { text-align:center; color:#5a6b8c; padding:22px 0 30px; font-size:13px; }
'@
[IO.File]::WriteAllText("$root\mycourses.css", $css)

# Distinct SVG thumbnails so each card is visually separable, plus a simple logo mark.
for ($i = 1; $i -le 7; $i++) {
  $hue = ($i * 47) % 360
  $svg = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='120'><rect width='180' height='120' fill='hsl($hue,62%,72%)'/><circle cx='60' cy='55' r='26' fill='hsl($hue,55%,45%)'/><rect x='100' y='28' width='62' height='10' rx='4' fill='rgba(255,255,255,.85)'/><rect x='100' y='46' width='46' height='10' rx='4' fill='rgba(255,255,255,.65)'/><rect x='100' y='64' width='54' height='10' rx='4' fill='rgba(255,255,255,.45)'/></svg>"
  [IO.File]::WriteAllText("$root\assets\thumb-$i.svg", $svg)
}
$logo = "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><rect width='28' height='28' rx='6' fill='#2f6fed'/><text x='14' y='20' font-family='Arial' font-size='16' fill='#fff' text-anchor='middle'>S</text></svg>"
[IO.File]::WriteAllText("$root\assets\logo.svg", $logo)

# Page B: visually opposite (light, single big heading) so a stale screenshot is unambiguous.
$pageB = @'
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><title>Course detail - Synthetic portal</title><link rel="stylesheet" href="/mycourses.css"></head>
<body class="mc-page" style="background:#ffffff">
  <main style="max-width:800px;margin:60px auto;padding:0 24px">
    <h1 style="font-size:44px;color:#111" id="pageb-title">PAGE B CONFIRMATION</h1>
    <p style="font-size:20px">This is the course detail page. If the observation shows My courses content, the screenshot is stale.</p>
    <p style="font-size:20px">Unique marker: <strong id="marker">ZEBRA-7741-ORCHID</strong></p>
  </main>
</body>
</html>
'@
[IO.File]::WriteAllText("$root\page-b.html", $pageB)
Write-Output 'fixture files written'
