export const getPlatformName = (url: string): string => {
  if (!url) return 'Website';
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '');
    
    if (hostname.includes('medium.com') || hostname.includes('scribe.rip')) return 'Medium';
    if (hostname.includes('reddit.com')) return 'Reddit';
    if (hostname.includes('bbc.')) return 'BBC';
    if (hostname.includes('nytimes.')) return 'New York Times';
    if (hostname.includes('amazon.')) return 'Amazon';
    if (hostname.includes('x.com') || hostname.includes('twitter.com')) return 'X';
    if (hostname.includes('bloomberg.')) return 'Bloomberg';
    if (hostname.includes('instagram.com')) return 'Instagram';
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'YouTube';
    if (hostname.includes('linkedin.com')) return 'LinkedIn';
    if (hostname.includes('theverge.com')) return 'The Verge';
    if (hostname.includes('wsj.com')) return 'WSJ';
    if (hostname.includes('cnbc.com')) return 'CNBC';
    if (hostname.includes('wired.com')) return 'Wired';
    if (hostname.includes('ign.com')) return 'IGN';
    if (hostname.includes('techcrunch.com')) return 'TechCrunch';
    if (hostname.includes('engadget.com')) return 'Engadget';

    const parts = hostname.split('.');
    const rootName = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length <= 3 
      ? parts[parts.length - 3] 
      : parts[parts.length - 2];
      
    if (rootName) {
      return rootName.charAt(0).toUpperCase() + rootName.slice(1);
    }
    return 'Website';
  } catch (e) {
    return 'Website';
  }
};

export const getFaviconUrl = (url: string): string => {
  if (!url) return '';
  try {
    const origin = new URL(url).origin;
    return "https://www.google.com/s2/favicons?sz=64&domain_url=" + origin;
  } catch (e) {
    return '';
  }
};

export const getWebpageScreenshotUrl = (url: string): string => {
  if (!url) return '';
  // Free reliable screenshot generator with decent dimensions for cards (1200x800)
  return `https://image.thum.io/get/width/1200/crop/800/noanimate/${url}`;
};
