// Scroll-triggered reveal
const observer = new IntersectionObserver(
  (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
  { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
);
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Cloudinary URL helper
function cloudUrl(folder, filename, transforms) {
  return `${CLOUDINARY_BASE}/${transforms}/${folder}/${filename}`;
}

// Archive lightbox
const lightbox = document.getElementById('lightbox');
if (lightbox && !document.getElementById('photo-grid')) {
  let photos = [];
  let currentIdx = 0;
  let seriesTitle = '';
  let touchStartX = 0;

  const lbImg = lightbox.querySelector('.lightbox-img');
  const lbMeta = lightbox.querySelector('.lightbox-meta');
  const lbTitle = lightbox.querySelector('.lightbox-title');

  function openArchiveLightbox(s, startIdx) {
    seriesTitle = s.title;
    photos = s.photos.map(p => cloudUrl(s.folder, p, 'f_auto,q_auto,w_1400'));
    currentIdx = startIdx || 0;
    showPhoto();
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
  }

  function showPhoto() {
    lbImg.src = photos[currentIdx];
    lbMeta.textContent = `${String(currentIdx + 1).padStart(3, '0')} / ${String(photos.length).padStart(3, '0')}`;
    lbTitle.textContent = seriesTitle;
  }

  function prev() { currentIdx = (currentIdx - 1 + photos.length) % photos.length; showPhoto(); }
  function next() { currentIdx = (currentIdx + 1) % photos.length; showPhoto(); }

  lightbox.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lightbox.querySelector('.lightbox-prev').addEventListener('click', prev);
  lightbox.querySelector('.lightbox-next').addEventListener('click', next);

  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

  document.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') prev();
    if (e.key === 'ArrowRight') next();
  });

  lightbox.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) dx < 0 ? next() : prev();
  });

  window._openLightbox = openArchiveLightbox;
}
