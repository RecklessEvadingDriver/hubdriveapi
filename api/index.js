const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

// Middleware with error handling
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Helper functions
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        console.log('Invalid URL in getBaseUrl:', url);
        return '';
    }
}

function getIndexQuality(str) {
    if (!str) return 1080; // Default to 1080p instead of 2160
    try {
        const match = str.match(/(\d{3,4})[pP]/);
        return match ? parseInt(match[1]) : 1080;
    } catch (e) {
        return 1080;
    }
}

function cleanTitle(title) {
    if (!title) return '';
    
    try {
        const parts = title.split(/[.\-_]/);
        
        const qualityTags = [
            "WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV",
            "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"
        ];

        const audioTags = [
            "AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"
        ];

        const subTags = [
            "ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"
        ];

        const codecTags = [
            "x264", "x265", "H264", "HEVC", "AVC"
        ];

        const startIndex = parts.findIndex(part =>
            qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
        );

        const endIndex = parts.findLastIndex(part =>
            subTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
            audioTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
            codecTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
        );

        if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
            return parts.slice(startIndex, endIndex + 1).join('.');
        } else if (startIndex !== -1) {
            return parts.slice(startIndex).join('.');
        } else {
            return parts.slice(-3).join('.');
        }
    } catch (error) {
        console.log('Error in cleanTitle:', error.message);
        return title.substring(0, 50); // Return first 50 chars as fallback
    }
}

// Simple axios instance with timeout and retry
const httpClient = axios.create({
    timeout: 10000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
});

class HubCloudExtractor {
    async getUrl(url, referer = 'HubDrive') {
        const results = [];
        
        try {
            console.log('HubCloudExtractor processing URL:', url);
            
            // Validate URL
            if (!url || typeof url !== 'string') {
                return { success: false, error: 'Invalid URL provided' };
            }

            const baseUrl = getBaseUrl(url);
            let href = '';

            if (url.includes('hubcloud.php')) {
                href = url;
            } else {
                try {
                    const response = await httpClient.get(url);
                    const $ = cheerio.load(response.data);
                    const rawHref = $('#download').attr('href') || '';
                    
                    if (rawHref.startsWith('http')) {
                        href = rawHref;
                    } else if (baseUrl) {
                        href = baseUrl.replace(/\/$/, '') + '/' + rawHref.replace(/^\//, '');
                    } else {
                        href = rawHref;
                    }
                } catch (error) {
                    console.log('Error fetching initial page:', error.message);
                    return { success: false, error: 'Failed to fetch download page' };
                }
            }

            if (!href) {
                return { success: false, error: 'No download link found' };
            }

            console.log('Processing href:', href);

            let $doc;
            try {
                const hrefResponse = await httpClient.get(href);
                $doc = cheerio.load(hrefResponse.data);
            } catch (error) {
                console.log('Error fetching href:', error.message);
                return { success: false, error: 'Failed to fetch download information' };
            }
            
            const size = $doc('i#size').text() || '';
            const header = $doc('div.card-header').text() || '';
            const headerDetails = cleanTitle(header);
            const quality = getIndexQuality(header);

            const labelExtras = [];
            if (headerDetails) labelExtras.push(headerDetails);
            if (size) labelExtras.push(size);
            
            const labelString = labelExtras.length > 0 ? `[${labelExtras.join('][')}]` : '';

            const buttons = $doc('div.card-body h2 a.btn');
            console.log(`Found ${buttons.length} download buttons`);

            // Process buttons
            for (let i = 0; i < buttons.length; i++) {
                try {
                    const element = buttons[i];
                    const $element = $doc(element);
                    const link = $element.attr('href');
                    const text = $element.text().trim();

                    if (!link) continue;

                    console.log(`Processing button ${i + 1}: ${text}`);

                    const buttonBaseUrl = getBaseUrl(link);

                    if (text.match(/FSL Server/i)) {
                        results.push({
                            name: `${referer} [FSL Server]`,
                            url: link,
                            quality: quality,
                            label: `${referer} [FSL Server] ${labelString}`.trim(),
                            type: 'fsl'
                        });
                    } else if (text.match(/Download File/i)) {
                        results.push({
                            name: referer,
                            url: link,
                            quality: quality,
                            label: `${referer} ${labelString}`.trim(),
                            type: 'direct'
                        });
                    } else if (text.match(/BuzzServer/i)) {
                        try {
                            const buzzResp = await httpClient.get(`${link}/download`, {
                                maxRedirects: 0,
                                validateStatus: () => true
                            });
                            
                            const dlink = buzzResp.headers.location || buzzResp.headers['hx-redirect'] || '';
                            if (dlink) {
                                const finalUrl = dlink.startsWith('http') ? dlink : (buttonBaseUrl + dlink);
                                results.push({
                                    name: `${referer} [BuzzServer]`,
                                    url: finalUrl,
                                    quality: quality,
                                    label: `${referer} [BuzzServer] ${labelString}`.trim(),
                                    type: 'buzz'
                                });
                            } else {
                                results.push({
                                    name: `${referer} [BuzzServer]`,
                                    url: link,
                                    quality: quality,
                                    label: `${referer} [BuzzServer] ${labelString}`.trim(),
                                    type: 'buzz'
                                });
                            }
                        } catch (error) {
                            console.log('BuzzServer failed, using direct link');
                            results.push({
                                name: `${referer} [BuzzServer]`,
                                url: link,
                                quality: quality,
                                label: `${referer} [BuzzServer] ${labelString}`.trim(),
                                type: 'buzz'
                            });
                        }
                    } else if (text.match(/pixeldra|pixel/i)) {
                        results.push({
                            name: 'Pixeldrain',
                            url: link,
                            quality: quality,
                            label: `Pixeldrain ${labelString}`.trim(),
                            type: 'pixeldrain'
                        });
                    } else if (text.match(/S3 Server/i)) {
                        results.push({
                            name: `${referer} S3 Server`,
                            url: link,
                            quality: quality,
                            label: `${referer} S3 Server ${labelString}`.trim(),
                            type: 's3'
                        });
                    } else if (text.match(/10Gbps/i)) {
                        try {
                            let currentLink = link;
                            let redirectUrl = null;
                            let redirectCount = 0;

                            while (redirectCount < 3) {
                                const response = await httpClient.get(currentLink, {
                                    maxRedirects: 0,
                                    validateStatus: () => true
                                });
                                
                                redirectUrl = response.headers.location;
                                if (!redirectUrl) break;
                                
                                if (redirectUrl.includes('link=')) {
                                    break;
                                }
                                currentLink = redirectUrl;
                                redirectCount++;
                            }

                            if (redirectUrl && redirectUrl.includes('link=')) {
                                const finalLink = redirectUrl.split('link=')[1];
                                results.push({
                                    name: `${referer} 10Gbps [Download]`,
                                    url: finalLink,
                                    quality: quality,
                                    label: `${referer} 10Gbps [Download] ${labelString}`.trim(),
                                    type: '10gbps'
                                });
                            } else {
                                results.push({
                                    name: `${referer} 10Gbps`,
                                    url: link,
                                    quality: quality,
                                    label: `${referer} 10Gbps ${labelString}`.trim(),
                                    type: '10gbps'
                                });
                            }
                        } catch (error) {
                            console.log('10Gbps failed, using direct link');
                            results.push({
                                name: `${referer} 10Gbps`,
                                url: link,
                                quality: quality,
                                label: `${referer} 10Gbps ${labelString}`.trim(),
                                type: '10gbps'
                            });
                        }
                    } else {
                        // For other servers
                        results.push({
                            name: `${referer} [${text}]`,
                            url: link,
                            quality: quality,
                            label: `${referer} [${text}] ${labelString}`.trim(),
                            type: 'other'
                        });
                    }
                } catch (buttonError) {
                    console.log(`Error processing button ${i + 1}:`, buttonError.message);
                    // Continue with next button
                }
            }

            return { 
                success: true, 
                data: results,
                metadata: {
                    quality: quality,
                    title: headerDetails,
                    size: size
                }
            };
            
        } catch (error) {
            console.error('HubCloudExtractor error:', error.message);
            return { 
                success: false, 
                error: `Extraction failed: ${error.message}`,
                data: [] 
            };
        }
    }
}

class HubdriveExtractor {
    async getUrl(url, referer = 'HubDrive') {
        try {
            console.log('HubdriveExtractor processing URL:', url);
            
            if (!url || typeof url !== 'string') {
                return { success: false, error: 'Invalid URL provided' };
            }

            const response = await httpClient.get(url);
            const $ = cheerio.load(response.data);
            
            const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
            
            if (!href) {
                return { success: false, error: 'No download button found on page' };
            }

            console.log('Found download href:', href);

            const hubCloud = new HubCloudExtractor();
            
            if (href.includes('hubcloud')) {
                return await hubCloud.getUrl(href, referer);
            } else {
                // For direct links, still use HubCloud extractor for consistency
                return await hubCloud.getUrl(href, referer);
            }
            
        } catch (error) {
            console.error('HubdriveExtractor error:', error.message);
            return { 
                success: false, 
                error: `Hubdrive extraction failed: ${error.message}` 
            };
        }
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Hubdrive Extractor API - Fixed Version',
        version: '1.0.1',
        status: 'running',
        endpoints: {
            '/api/extract': 'POST - Extract download links from Hubdrive',
            '/api/extract/hubcloud': 'POST - Extract directly from HubCloud',
            '/api/health': 'GET - Health check',
            '/api/providers': 'GET - List supported providers'
        },
        usage: {
            method: 'POST',
            url: '/api/extract',
            body: { 
                url: 'your_hubdrive_url_here',
                referer: 'optional_referer' 
            }
        }
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.get('/api/providers', (req, res) => {
    res.json({
        providers: [
            'FSL Server',
            'BuzzServer', 
            'Pixeldrain',
            'S3 Server', 
            '10Gbps Server',
            'Direct Download'
        ]
    });
});

app.post('/api/extract', async (req, res) => {
    try {
        const { url, referer = 'HubDrive' } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL parameter is required in request body'
            });
        }

        // Basic URL validation
        if (typeof url !== 'string' || !url.startsWith('http')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format. Must start with http/https'
            });
        }

        console.log(`Extraction request for: ${url}`);
        const extractor = new HubdriveExtractor();
        const result = await extractor.getUrl(url, referer);

        res.json({
            success: result.success,
            url: url,
            referer: referer,
            results: result.data || [],
            count: result.data ? result.data.length : 0,
            error: result.error,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('API route error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error during extraction',
            message: error.message
        });
    }
});

app.post('/api/extract/hubcloud', async (req, res) => {
    try {
        const { url, referer = 'HubCloud' } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL parameter is required'
            });
        }

        if (typeof url !== 'string' || !url.startsWith('http')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        console.log(`Direct HubCloud extraction for: ${url}`);
        const extractor = new HubCloudExtractor();
        const result = await extractor.getUrl(url, referer);

        res.json({
            success: result.success,
            url: url,
            referer: referer,
            results: result.data || [],
            count: result.data ? result.data.length : 0,
            error: result.error,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('HubCloud API route error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        available_endpoints: [
            'GET /',
            'GET /api/health', 
            'GET /api/providers',
            'POST /api/extract',
            'POST /api/extract/hubcloud'
        ]
    });
});

// Global error handler - MUST be last
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    res.status(500).json({
        success: false,
        error: 'Unexpected server error',
        message: error.message
    });
});

// Export the app for Vercel
module.exports = app;
