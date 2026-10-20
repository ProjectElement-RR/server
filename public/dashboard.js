const API_BASE = window.location.origin;

async function fetchHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        updateServerStatus(data);
        updateMemoryStats(data);
    } catch (error) {
        console.error('Failed to fetch health:', error);
        setServerOffline();
    }
}

async function fetchPlayers() {
    try {
        const response = await fetch(`${API_BASE}/api/dashboard/players`);
        const data = await response.json();
        updatePlayerList(data);
    } catch (error) {
        console.error('Failed to fetch players:', error);
        document.getElementById('playerList').innerHTML = '<p class="loading">Failed to load players</p>';
    }
}

async function fetchSessions() {
    try {
        const response = await fetch(`${API_BASE}/api/dashboard/sessions`);
        const data = await response.json();
        updateSessionList(data);
    } catch (error) {
        console.error('Failed to fetch sessions:', error);
        document.getElementById('sessionList').innerHTML = '<p class="loading">Failed to load sessions</p>';
    }
}

async function fetchStats() {
    try {
        const response = await fetch(`${API_BASE}/api/dashboard/stats`);
        const data = await response.json();
        document.getElementById('totalPlayers').textContent = data.totalPlayers || 0;
        document.getElementById('onlinePlayers').textContent = data.onlinePlayers || 0;
        document.getElementById('totalSessions').textContent = data.totalSessions || 0;
        document.getElementById('uptime').textContent = formatUptime(data.uptime || 0);
    } catch (error) {
        console.error('Failed to fetch stats:', error);
    }
}

async function fetchGallery() {
    try {
        const response = await fetch(`${API_BASE}/api/gallery`);
        const data = await response.json();
        updateGallery(data);
    } catch (error) {
        console.error('Failed to fetch gallery:', error);
        document.getElementById('galleryGrid').innerHTML = '<p class="loading">Failed to load gallery</p>';
    }
}

async function fetchMyImages() {
    try {
        // For now, use player ID 1 as default - in production this would come from auth
        const playerId = 1;
        const response = await fetch(`${API_BASE}/api/images/player/${playerId}`);
        const data = await response.json();
        updateMyImages(data);
    } catch (error) {
        console.error('Failed to fetch my images:', error);
        document.getElementById('myImagesGrid').innerHTML = '<p class="loading">Failed to load your images</p>';
    }
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

function updateServerStatus(data) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    if (data.status === 'ok') {
        statusDot.classList.add('online');
        statusDot.classList.remove('offline');
        statusText.textContent = 'Online';
        statusText.style.color = '#15803d';
    } else {
        statusDot.classList.add('offline');
        statusDot.classList.remove('online');
        statusText.textContent = 'Offline';
        statusText.style.color = '#6b7280';
    }
}

function setServerOffline() {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    statusDot.classList.add('offline');
    statusDot.classList.remove('online');
    statusText.textContent = 'Offline';
    statusText.style.color = '#6b7280';
}

function updateMemoryStats(data) {
    if (!data.memory) return;

    const memory = data.memory;
    const heapUsed = parseFloat(memory.heapUsed);
    const heapTotal = parseFloat(memory.heapTotal);

    document.getElementById('heapUsed').textContent = memory.heapUsed;
    document.getElementById('heapTotal').textContent = memory.heapTotal;
    document.getElementById('external').textContent = memory.external;
    document.getElementById('rss').textContent = memory.rss;

    // Update memory bar
    const percentage = (heapUsed / heapTotal) * 100;
    const memoryBar = document.getElementById('memoryBar');
    memoryBar.style.width = `${percentage}%`;

    // Set color based on usage
    memoryBar.classList.remove('warning', 'critical');
    if (percentage > 75) {
        memoryBar.classList.add('critical');
    } else if (percentage > 50) {
        memoryBar.classList.add('warning');
    } else {
        // Normal state - use base green color
    }
}

function updatePlayerList(players) {
    const playerList = document.getElementById('playerList');
    const playerCount = document.getElementById('playerCount');

    if (!players || players.length === 0) {
        playerList.innerHTML = '<p class="loading">No players found</p>';
        playerCount.textContent = '0 players';
        return;
    }

    playerCount.textContent = `${players.length} player${players.length !== 1 ? 's' : ''}`;

    playerList.innerHTML = players.map(player => `
        <div class="player-item">
            <div class="player-info">
                <div class="player-name">${player.username || 'Unknown'}</div>
                <div class="player-level">Level ${player.level || 1}</div>
            </div>
            <div class="player-xp">${player.xp || 0} XP</div>
            <div class="player-status ${player.isOnline ? 'online' : 'offline'}">
                ${player.isOnline ? '● Online' : '○ Offline'}
            </div>
        </div>
    `).join('');
}

function updateSessionList(sessions) {
    const sessionList = document.getElementById('sessionList');
    const sessionCount = document.getElementById('sessionCount');

    if (!sessions || sessions.length === 0) {
        sessionList.innerHTML = '<p class="loading">No active sessions</p>';
        sessionCount.textContent = '0 sessions';
        return;
    }

    sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

    sessionList.innerHTML = sessions.map(session => {
        const isPrivate = session.Private;
        const playerCount = session.playerCount || 0;
        const maxCapacity = session.MaxCapacity || 20;

        return `
            <div class="session-item">
                <div class="session-info">
                    <div class="session-name">${session.Name || 'Unknown Room'}</div>
                    <div class="session-players">${playerCount}/${maxCapacity} players</div>
                </div>
                <div class="session-status ${isPrivate ? 'private' : 'active'}">
                    ${isPrivate ? 'Private' : 'Public'}
                </div>
            </div>
        `;
    }).join('');
}

function updateOnlinePlayerList(players) {
    const onlinePlayerList = document.getElementById('onlinePlayerList');
    const onlinePlayerCount = document.getElementById('onlinePlayerCount');

    const onlinePlayers = players.filter(p => p.isOnline);

    if (!onlinePlayers || onlinePlayers.length === 0) {
        onlinePlayerList.innerHTML = '<p class="loading">No online players</p>';
        onlinePlayerCount.textContent = '0 online';
        return;
    }

    onlinePlayerCount.textContent = `${onlinePlayers.length} online`;

    onlinePlayerList.innerHTML = onlinePlayers.map(player => `
        <div class="player-item">
            <div class="player-info">
                <div class="player-name">${player.username || 'Unknown'}</div>
                <div class="player-level">Level ${player.level || 1}</div>
            </div>
            <div class="player-status online">
                ● Online
            </div>
        </div>
    `).join('');
}

function updateGallery(images) {
    const galleryGrid = document.getElementById('galleryGrid');
    const galleryCount = document.getElementById('galleryCount');

    if (!images || images.length === 0) {
        galleryGrid.innerHTML = '<p class="loading">No images in gallery</p>';
        galleryCount.textContent = '0 images';
        return;
    }

    galleryCount.textContent = `${images.length} image${images.length !== 1 ? 's' : ''}`;

    galleryGrid.innerHTML = images.map(image => {
        // Ensure the image path is properly formatted
        const imagePath = image.file_path.startsWith('/') ? image.file_path : `/${image.file_path}`;
        return `
        <div class="gallery-item">
            <img src="${imagePath}" alt="Gallery Image" onerror="this.src='/images/__default.png'">
            <div class="gallery-item-info">
                <p>Uploaded by: ${image.username || 'Unknown'}</p>
                <p class="image-date">${new Date(image.uploaded_at).toLocaleDateString()}</p>
            </div>
        </div>
    `;
    }).join('');
}

function updateMyImages(images) {
    const myImagesGrid = document.getElementById('myImagesGrid');
    const myImagesCount = document.getElementById('myImagesCount');

    if (!images || images.length === 0) {
        myImagesGrid.innerHTML = '<p class="loading">No images found</p>';
        myImagesCount.textContent = '0 images';
        return;
    }

    myImagesCount.textContent = `${images.length} image${images.length !== 1 ? 's' : ''}`;

    myImagesGrid.innerHTML = images.map(image => {
        // Ensure the image path is properly formatted
        const imagePath = image.file_path.startsWith('/') ? image.file_path : `/${image.file_path}`;
        const imageType = image.image_type || 'unknown';
        return `
        <div class="gallery-item">
            <img src="${imagePath}" alt="My Image" onerror="this.src='/images/__default.png'">
            <div class="gallery-item-info">
                <p>Type: ${imageType}</p>
                <p class="image-date">${new Date(image.uploaded_at).toLocaleDateString()}</p>
            </div>
        </div>
    `;
    }).join('');
}

// Navigation handling
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all buttons
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        // Add active class to clicked button
        btn.classList.add('active');

        // Hide all sections
        document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));
        // Show selected section
        const sectionId = btn.dataset.section;
        document.getElementById(sectionId).classList.add('active');

        // Fetch data for the section
        if (sectionId === 'gallery') {
            fetchGallery();
        } else if (sectionId === 'myimages') {
            fetchMyImages();
        }
    });
});

// Image upload handling
document.getElementById('imageUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('playerId', 1); // Default player ID for testing

    try {
        const response = await fetch(`${API_BASE}/api/images/upload/cloud`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            fetchGallery();
            alert('Image uploaded successfully!');
        } else {
            alert('Failed to upload image');
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Failed to upload image');
    }

    e.target.value = '';
});

// My Images upload handling
document.getElementById('myImageUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('playerId', 1); // Default player ID for testing

    try {
        const response = await fetch(`${API_BASE}/api/images/upload/cloud`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            fetchMyImages();
            alert('Image uploaded successfully!');
        } else {
            alert('Failed to upload image');
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Failed to upload image');
    }

    e.target.value = '';
});

document.getElementById('profileUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('playerId', 1); // Default player ID for testing

    try {
        const response = await fetch(`${API_BASE}/api/images/upload/profile`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            document.getElementById('profilePreview').src = data.path;
            alert('Profile image updated successfully!');
        } else {
            alert('Failed to update profile image');
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Failed to update profile image');
    }

    e.target.value = '';
});

function refreshData() {
    fetchHealth();
    fetchStats();
    const activeSection = document.querySelector('.section.active').id;
    if (activeSection === 'players') {
        fetchPlayers();
    } else if (activeSection === 'sessions') {
        fetchSessions();
    } else if (activeSection === 'gallery') {
        fetchGallery();
    } else if (activeSection === 'myimages') {
        fetchMyImages();
    }
}

// Initial load
document.addEventListener('DOMContentLoaded', () => {
    refreshData();
});
