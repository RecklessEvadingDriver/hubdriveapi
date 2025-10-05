const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Helper functions
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return '';
    }
}

function getIndexQuality(str) {
    if (!str) return 2160;
    const match = str.match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

function cleanTitle(title) {
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
}

// Load Extractor function to handle other providers
async function loadExtractor(url, referer, subtitleCallback, callback) {
    try {
        // This would integrate with other extractor services
        // For now, we'll return the direct link
        callback({
            name: referer || 'Direct',
            url: url,
            quality: 1080,
            label: `${referer || 'Direct'} Link`
        });
    } catch (error) {
        console.log('Load extractor error:', error.message);
    }
}

class HubCloudExtractor {
    async getUrl(url, referer = 'HubDrive', subtitleCallback = null, callback = null) {
        const results = [];
        
        try {
            // Validate URL
            new URL(url);
            const baseUrl = getBaseUrl(url);

            let href = '';
            
            if (url.includes('hubcloud.php')) {
                href = url;
            } else {
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                const $ = cheerio.load(response.data);
                const rawHref = $('#download').attr('href') || '';
                
                if (rawHref.startsWith('http')) {
                    href = rawHref;
                } else {
                    href = baseUrl.replace(/\/$/, '') + '/' + rawHref.replace(/^\//, '');
                }
            }

            if (!href) {
                return { success: false, error: 'No valid href found' };
            }

            const hrefResponse = await axios.get(href, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': url
                }
            });
            const $doc = cheerio.load(hrefResponse.data);
            
            const size = $doc('i#size').text() || '';
            const header = $doc('div.card-header').text() || '';
            const headerDetails = cleanTitle(header);
            const quality = getIndexQuality(header);

            const labelExtras = [];
            if (headerDetails) labelExtras.push(`[${headerDetails}]`);
            if (size) labelExtras.push(`[${size}]`);
            
            const labelString = labelExtras.join(' ');

            const buttons = $doc('div.card-body h2 a.btn');
            
            // Process all buttons sequentially to maintain order
            for (let i = 0; i < buttons.length; i++) {
                const element = buttons[i];
                const $element = $doc(element);
                const link = $element.attr('href');
                const text = $element.text();
                const buttonBaseUrl = getBaseUrl(link);

                if (!link) continue;

                console.log(`Processing button: ${text} -> ${link}`);

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
                        const buzzResp = await axios.get(`${link}/download`, {
                            maxRedirects: 0,
                            validateStatus: null,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Referer': link
                            }
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
                            // Fallback to direct link
                            results.push({
                                name: `${referer} [BuzzServer]`,
                                url: link,
                                quality: quality,
                                label: `${referer} [BuzzServer] ${labelString}`.trim(),
                                type: 'buzz'
                            });
                        }
                    } catch (error) {
                        console.log('BuzzServer redirect failed:', error.message);
                        // Fallback
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

                        while (redirectCount < 5) { // Prevent infinite loops
                            const response = await axios.get(currentLink, {
                                maxRedirects: 0,
                                validateStatus: null,
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                                }
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
                            // Fallback to direct link
                            results.push({
                                name: `${referer} 10Gbps`,
                                url: link,
                                quality: quality,
                                label: `${referer} 10Gbps ${labelString}`.trim(),
                                type: '10gbps'
                            });
                        }
                    } catch (error) {
                        console.log('10Gbps extraction failed:', error.message);
                        // Fallback
                        results.push({
                            name: `${referer} 10Gbps`,
                            url: link,
                            quality: quality,
                            label: `${referer} 10Gbps ${labelString}`.trim(),
                            type: '10gbps'
                        });
                    }
                } else {
                    // For other/unrecognized servers, use loadExtractor
                    try {
                        const extractorResult = await this.loadExtractorWrapper(link, referer);
                        if (extractorResult && extractorResult.url) {
                            results.push({
                                name: `${referer} [${text}]`,
                                url: extractorResult.url,
                                quality: quality,
                                label: `${referer} [${text}] ${labelString}`.trim(),
                                type: 'external'
                            });
                        }
                    } catch (extractorError) {
                        console.log(`Extractor failed for ${text}:`, extractorError.message);
                        // Still add the direct link as fallback
                        results.push({
                            name: `${referer} [${text}]`,
                            url: link,
                            quality: quality,
                            label: `${referer} [${text}] ${labelString}`.trim(),
                            type: 'fallback'
                        });
                    }
                }
            }

            return { success: true, data: results };
            
        } catch (error) {
            console.error('HubCloud extraction error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async loadExtractorWrapper(url, referer) {
        // This is a simplified version - in real implementation, 
        // you would integrate with other extractor services
        try {
            // Try to get direct link first
            const response = await axios.get(url, {
                maxRedirects: 5,
                validateStatus: null,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': referer
                }
            });
            
            // If we get a direct file or final URL
            const finalUrl = response.request?.res?.responseUrl || url;
            return { url: finalUrl };
            
        } catch (error) {
            console.log('Load extractor wrapper error:', error.message);
            return { url: url }; // Fallback to original URL
        }
    }
}

class HubdriveExtractor {
    async getUrl(url, referer = 'HubDrive') {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            const $ = cheerio.load(response.data);
            
            const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
            
            if (!href) {
                return { success: false, error: 'No download link found' };
            }

            console.log(`Found href: ${href}`);

            if (href.includes('hubcloud')) {
                const hubCloud = new HubCloudExtractor();
                return await hubCloud.getUrl(href, referer);
            } else {
                // For direct links or other providers
                const hubCloud = new HubCloudExtractor();
                return await hubCloud.getUrl(href, referer);
            }
            
        } catch (error) {
            console.error('Hubdrive extraction error:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Hubdrive Extractor API - Complete Implementation',
        version: '1.0.0',
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
        },
        supported_providers: [
            'FSL Server',
            'BuzzServer', 
            'Pixeldrain',
            'S3 Server',
            '10Gbps Server',
            'Direct Download',
            'Other External Providers'
        ]
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/api/providers', (req, res) => {
    res.json({
        providers: [
            {
                name: 'FSL Server',
                type: 'fsl',
                description: 'Direct file server'
            },
            {
                name: 'BuzzServer',
                type: 'buzz',
                description: 'BuzzServer with redirect handling'
            },
            {
                name: 'Pixeldrain',
                type: 'pixeldrain',
                description: 'Pixeldrain file hosting'
            },
            {
                name: 'S3 Server',
                type: 's3', 
                description: 'Amazon S3 compatible storage'
            },
            {
                name: '10Gbps Server',
                type: '10gbps',
                description: 'High speed download server'
            },
            {
                name: 'Other Providers',
                type: 'external',
                description: 'Various external video hosts'
            }
        ]
    });
});

app.post('/api/extract', async (req, res) => {
    try {
        const { url, referer = 'HubDrive' } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL parameter is required'
            });
        }

        // Validate URL format
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        console.log(`Extracting from: ${url}`);
        const extractor = new HubdriveExtractor();
        const result = await extractor.getUrl(url, referer);

        if (result.success) {
            res.json({
                success: true,
                url: url,
                referer: referer,
                results: result.data,
                count: result.data.length,
                providers: [...new Set(result.data.map(r => r.type))],
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                url: url,
                referer: referer
            });
        }
        
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
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

        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        console.log(`Extracting directly from HubCloud: ${url}`);
        const extractor = new HubCloudExtractor();
        const result = await extractor.getUrl(url, referer);

        if (result.success) {
            res.json({
                success: true,
                url: url,
                referer: referer,
                results: result.data,
                count: result.data.length,
                providers: [...new Set(result.data.map(r => r.type))],
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                url: url,
                referer: referer
            });
        }
        
    } catch (error) {
        console.error('HubCloud API Error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        available_endpoints: ['/api/extract', '/api/extract/hubcloud', '/api/health', '/api/providers']
    });
});

// Export for Vercel
module.exports = app;
