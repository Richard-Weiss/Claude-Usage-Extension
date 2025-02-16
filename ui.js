(function () {
	'use strict';

	const DEBUG_MODE = false
	function debugLog(...args) {
		if (DEBUG_MODE) {
			console.log(...args);
		}
	}

	if (window.claudeTrackerInstance) {
		debugLog('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	let config;

	//#region Storage Interface
	class TokenStorageInterface {
		async getCollapsedState() {
			return await sendBackgroundMessage({ type: 'getCollapsedState' });
		}

		async setCollapsedState(isCollapsed) {
			return await sendBackgroundMessage({
				type: 'setCollapsedState',
				isCollapsed
			});
		}

		async getPreviousVersion() {
			return await sendBackgroundMessage({ type: 'getPreviousVersion' });
		}

		async setCurrentVersion(version) {
			return await sendBackgroundMessage({
				type: 'setCurrentVersion',
				version
			});
		}
	}
	let storageInterface;
	//#endregion

	//State variables
	let currentlyDisplayedModel = 'default';
	let currentConversation = -1;
	let modelSections = {};
	let uiReady = false;
	const pendingUpdates = [];


	//#region Utils
	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	async function sendBackgroundMessage(message) {
		const enrichedMessage = {
			...message,
			//sessionKey: document.cookie.split('; ').find(row => row.startsWith('sessionKey='))?.split('=')[1], //It's HTTPOnly...
			orgId: document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1]
		};
		return browser.runtime.sendMessage(enrichedMessage);
	}

	async function waitForElement(target, selector, maxTime = 1000) {
		let elapsed = 0;
		const waitInterval = 100
		while (elapsed < maxTime) {
			const element = target.querySelector(selector);
			if (element) return element;
			await sleep(waitInterval);
			elapsed += waitInterval;
		}

		return null;
	}

	async function getCurrentModel() {
		const overrideSelector = await waitForElement(document, config.SELECTORS.MODEL_OVERRIDE, 1000);
		if (overrideSelector) {
			const overrideModel = overrideSelector.options[overrideSelector.selectedIndex].text
			let overrideModelName = overrideModel.toLowerCase();
			const modelTypes = Object.keys(config.MODEL_TOKEN_CAPS).filter(key => key !== 'default');

			for (const modelType of modelTypes) {
				if (overrideModelName.includes(modelType.toLowerCase())) {
					return modelType;
				}
			}
		}
		const modelSelector = await waitForElement(document, config.SELECTORS.MODEL_PICKER, 3000);
		debugLog("Model selector", modelSelector)
		if (!modelSelector) return 'default';

		let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
		debugLog("Full model name", fullModelName)
		if (!fullModelName || fullModelName === 'default') return 'default';

		fullModelName = fullModelName.toLowerCase();
		const modelTypes = Object.keys(config.MODEL_TOKEN_CAPS).filter(key => key !== 'default');

		for (const modelType of modelTypes) {
			if (fullModelName.includes(modelType.toLowerCase())) {
				return modelType;
			}
		}
		debugLog("Could not find matching model, returning default")
		return 'default';
	}

	function isMobileView() {
		// First check if we're on a chat page
		if (!window.location.pathname.startsWith('/chat/')) {
			return false;
		}

		// Check if height > width (portrait orientation)
		return window.innerHeight > window.innerWidth;
	}
	//#endregion

	//#region UI elements
	function createModelSection(modelName, isActive) {
		const container = document.createElement('div');
		container.style.cssText = `
			margin-bottom: 12px;
			border-bottom: 1px solid #3B3B3B;
			padding-bottom: 8px;
			opacity: ${isActive ? '1' : '0.7'};
			transition: opacity 0.2s;
			${isMobileView() && !isActive ? 'display: none;' : ''}
		`;

		container.style.cssText += `
        	position: relative;
    	`;

		const sectionHeader = document.createElement('div');
		sectionHeader.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            color: white;
            font-size: 12px;
        `;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
            cursor: pointer;
            transition: transform 0.2s;
            font-size: 10px;
        `;

		const title = document.createElement('div');
		title.textContent = modelName;
		title.style.cssText = `flex-grow: 1;`;

		const activeIndicator = document.createElement('div');
		activeIndicator.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #3b82f6;
            opacity: ${isActive ? '1' : '0'};
            transition: opacity 0.2s;
        `;

		sectionHeader.appendChild(arrow);
		sectionHeader.appendChild(title);
		sectionHeader.appendChild(activeIndicator);

		const content = document.createElement('div');

		const resetTimeDisplay = document.createElement('div');
		resetTimeDisplay.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-bottom: 8px;
		`;
		resetTimeDisplay.textContent = 'Reset in: Not set.';


		const progressContainer = document.createElement('div');
		progressContainer.style.cssText = `
            background: #3B3B3B;
            height: 6px;
            border-radius: 3px;
            overflow: hidden;
        `;

		const progressBar = document.createElement('div');
		progressBar.style.cssText = `
            width: 0%;
            height: 100%;
            background: #3b82f6;
            transition: width 0.3s ease, background-color 0.3s ease;
        `;

		const tooltip = document.createElement('div');
		tooltip.style.cssText = `
			position: absolute;
			bottom: 100%;
			left: 50%;
			transform: translateX(-50%);
			background: rgba(0, 0, 0, 0.9);
			color: white;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			opacity: 0;
			transition: opacity 0.2s;
			pointer-events: none;
			margin-bottom: 4px;
			white-space: nowrap;
			z-index: 10000;
		`;

		// Add hover events to the section container
		container.addEventListener('mouseenter', () => {
			tooltip.style.opacity = '1';
		});
		container.addEventListener('mouseleave', () => {
			tooltip.style.opacity = '0';
		});

		progressContainer.appendChild(progressBar);

		const messageCounter = document.createElement('div');
		messageCounter.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-top: 4px;
		`;
		messageCounter.textContent = 'Messages: 0';
		content.appendChild(messageCounter);  // Add the counter

		content.appendChild(resetTimeDisplay);
		content.appendChild(progressContainer);
		content.appendChild(tooltip);

		container.appendChild(sectionHeader);
		container.appendChild(content);

		// Add collapsed state tracking
		let isCollapsed = !isActive; // Start collapsed if not active
		content.style.display = isCollapsed ? 'none' : 'block';
		arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

		// Toggle section collapse/expand
		arrow.addEventListener('click', (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
		});

		function setActive(active, isHomePage) {
			activeIndicator.style.opacity = active ? '1' : '0';
			container.style.opacity = active ? '1' : '0.7';
			if (!isHomePage || isMobileView()) {
				// In desktop non-home page (or mobile everywhere), completely hide inactive sections
				container.style.display = active ? 'block' : 'none';
			} else {
				// In desktop home page, just collapse inactive sections
				container.style.display = 'block';
			}

			if (active) {
				isCollapsed = false;
				content.style.display = 'block';
				arrow.style.transform = '';
			} else if (!isHomePage) {
				isCollapsed = true;
				content.style.display = 'none';
				arrow.style.transform = 'rotate(-90deg)';
			}
		}

		return {
			container,
			progressBar,
			resetTimeDisplay,
			tooltip,
			messageCounter,
			setActive
		};
	}

	async function checkVersionNotification() {
		const previousVersion = await storageInterface.getPreviousVersion();
		const currentVersion = browser.runtime.getManifest().version;
		// Skip if versions match
		if (previousVersion === currentVersion) return null;

		// Store current version
		await storageInterface.setCurrentVersion(currentVersion);

		return {
			previousVersion,
			currentVersion
		};
	}

	function createVersionNotificationCard(versionInfo) {
		const notificationCard = document.createElement('div');
		notificationCard.style.cssText = `
			position: absolute;
			bottom: calc(100% + 10px);
			left: 0;
			right: 0;
			background: #2D2D2D;
			border: 1px solid #3B3B3B;
			border-radius: 8px;
			padding: 12px;
			color: white;
			font-size: 12px;
			text-align: center;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		`;

		const message = document.createElement('div');
		message.style.marginBottom = '10px';
		message.textContent = versionInfo.previousVersion ?
			`Updated from v${versionInfo.previousVersion} to v${versionInfo.currentVersion}!` :
			`Welcome to the usage tracker! You're on v${versionInfo.currentVersion}`;

		const kofiButton = document.createElement('a');
		kofiButton.href = 'https://ko-fi.com/R6R14IUBY';
		kofiButton.target = '_blank';
		kofiButton.style.cssText = `
			display: block;
			text-align: center;
			margin-top: 10px;
		`;

		const kofiImg = document.createElement('img');
		kofiImg.src = browser.runtime.getURL('kofi-button.png');
		kofiImg.height = 36;
		kofiImg.style.border = '0';
		kofiImg.alt = 'Buy Me a Coffee at ko-fi.com';

		kofiButton.appendChild(kofiImg);

		const closeButton = document.createElement('button');
		closeButton.style.cssText = `
			position: absolute;
			top: 8px;
			right: 8px;
			background: none;
			border: none;
			color: #3b82f6;
			cursor: pointer;
			font-size: 14px;
		`;
		closeButton.textContent = '×';
		closeButton.onclick = () => notificationCard.remove();

		notificationCard.appendChild(message);
		notificationCard.appendChild(kofiButton);
		notificationCard.appendChild(closeButton);

		return notificationCard;
	}

	async function initUI() {
		const container = document.createElement('div');
		container.style.cssText = `
			position: fixed;
			bottom: 20px;
			right: 20px;
			background: #2D2D2D;
			border: 1px solid #3B3B3B;
			border-radius: 8px;
			z-index: 9999;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			user-select: none;
		`;

		// Header (always visible)
		const header = document.createElement('div');
		header.style.cssText = `
			display: flex;
			align-items: center;
			padding: 8px 10px;
			color: white;
			font-size: 12px;
			gap: 8px;
			cursor: move;
		`;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
			cursor: pointer;
			transition: transform 0.2s;
		`;

		// Create estimate display for the header
		const headerEstimateDisplay = document.createElement('div');
		headerEstimateDisplay.id = 'messages-left-estimate';
		headerEstimateDisplay.style.cssText = `
			flex-grow: 1;
			white-space: nowrap;
		`;
		headerEstimateDisplay.textContent = 'Est. messages left: Loading...';

		header.appendChild(arrow);
		header.appendChild(headerEstimateDisplay);

		// Counters
		const currentConversationDisplay = document.createElement('div');
		currentConversationDisplay.style.cssText = `
			color: white;
			font-size: 12px;
			padding: 0 10px;
			margin-bottom: 8px;
			border-bottom: 1px solid #3B3B3B;
			padding-bottom: 8px;
		`;

		const lengthDisplay = document.createElement('div');
		lengthDisplay.id = 'conversation-token-count';
		lengthDisplay.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-top: 4px;
		`;
		lengthDisplay.textContent = 'Current cost: 0 tokens';

		currentConversationDisplay.appendChild(lengthDisplay);

		// Content container (collapsible)
		const content = document.createElement('div');
		content.style.cssText = `
			padding: 0 10px 10px 10px;
			min-width: 150px;  // minimum width to ensure readability
			max-width: 275px;  // maximum width for larger content
			width: fit-content;  // allow container to shrink to fit content
		`;

		// Create sections for each model
		config.MODELS.forEach(model => {
			const isActive = model === currentlyDisplayedModel;
			const section = createModelSection(model, isActive);
			modelSections[model] = section;
			content.appendChild(section.container);
		});

		container.appendChild(header);
		container.appendChild(currentConversationDisplay);
		container.appendChild(content);
		document.body.appendChild(container);

		// Get stored collapse state
		let isCollapsed = await storageInterface.getCollapsedState();
		content.style.display = isCollapsed ? 'none' : 'block';
		arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

		// Toggle collapse/expand
		arrow.addEventListener('click', async (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

			// Also hide lengthDisplay on mobile
			if (isMobileView()) {
				lengthDisplay.style.display = isCollapsed ? 'none' : 'block';
			}

			// Store the new state
			await storageInterface.setCollapsedState(isCollapsed);
		});

		if (isMobileView() && isCollapsed) {
			lengthDisplay.style.display = 'none';
		}

		// Dragging functionality
		let isDragging = false;
		let currentX;
		let currentY;
		let initialX;
		let initialY;

		function handleDragStart(e) {
			if (e.target === arrow) return;

			isDragging = true;
			if (e.type === "mousedown") {
				initialX = e.clientX - container.offsetLeft;
				initialY = e.clientY - container.offsetTop;
			} else if (e.type === "touchstart") {
				initialX = e.touches[0].clientX - container.offsetLeft;
				initialY = e.touches[0].clientY - container.offsetTop;
			}
			header.style.cursor = 'grabbing';
		}

		function handleDragMove(e) {
			if (!isDragging) return;
			e.preventDefault();

			if (e.type === "mousemove") {
				currentX = e.clientX - initialX;
				currentY = e.clientY - initialY;
			} else if (e.type === "touchmove") {
				currentX = e.touches[0].clientX - initialX;
				currentY = e.touches[0].clientY - initialY;
			}

			const maxX = window.innerWidth - container.offsetWidth;
			const maxY = window.innerHeight - container.offsetHeight;
			currentX = Math.min(Math.max(0, currentX), maxX);
			currentY = Math.min(Math.max(0, currentY), maxY);

			container.style.left = `${currentX}px`;
			container.style.top = `${currentY}px`;
			container.style.right = 'auto';
			container.style.bottom = 'auto';
		}

		function handleDragEnd() {
			isDragging = false;
			header.style.cursor = 'move';
		}

		// Mouse events
		header.addEventListener('mousedown', handleDragStart);
		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);

		// Touch events
		header.addEventListener('touchstart', handleDragStart, { passive: false });
		document.addEventListener('touchmove', handleDragMove, { passive: false });
		document.addEventListener('touchend', handleDragEnd);
		document.addEventListener('touchcancel', handleDragEnd);

		const versionInfo = await checkVersionNotification();
		debugLog("Version info", versionInfo)
		if (versionInfo) {
			const notificationCard = createVersionNotificationCard(versionInfo);
			container.appendChild(notificationCard);
		}


		uiReady = true;
		// Process any updates that arrived before UI was ready
		while (pendingUpdates.length > 0) {
			debugLog("UI is ready, processing pending updates...")
			const update = pendingUpdates.shift();
			await updateProgressBar(update);
		}

		// Initialize model section visibility
		const isHomePage = getConversationId() === null;
		config.MODELS.forEach(async modelName => {
			const section = modelSections[modelName];
			if (section) {
				const isActiveModel = modelName === currentlyDisplayedModel;
				section.setActive(isActiveModel, isHomePage);
			}
		});
	}


	// New version takes a data object instead of fetching
	async function updateProgressBar(data) {
		debugLog("Got data", data)
		if (!uiReady) {
			debugLog("UI not ready, pushing to pending updates...")
			pendingUpdates.push(data);
			return;
		}

		let {
			conversationLength,
			modelData,  // Object containing data for all models
		} = data;

		// Update conversation length display
		const lengthDisplay = document.getElementById('conversation-token-count');
		if (lengthDisplay) {
			if (conversationLength) {
				lengthDisplay.textContent = `Current cost: ${conversationLength.toLocaleString()} tokens`;
			} else {
				const lengthText = lengthDisplay.textContent;
				const lengthMatch = lengthText.match(/Current cost:\s*([\d\s.,]+)\s*tokens/);
				if (lengthMatch) {
					// Remove spaces, keep last decimal/comma as decimal point, remove others
					const cleaned = lengthMatch[1]
						.replace(/\s/g, '')         // Remove spaces
						.replace(/[.,]/g, '');      // Remove all decimal points and commas
					conversationLength = parseInt(cleaned);
				}
			}
		}

		// Update messages left estimate if we have the current model
		const estimateDisplay = document.getElementById('messages-left-estimate');
		if (estimateDisplay) {
			//Let's ensure the model is up to date...
			currentlyDisplayedModel = await getCurrentModel();

			// Get the token cap for current model, or use default if not found
			const maxTokens = config.MODEL_TOKEN_CAPS[currentlyDisplayedModel] ||
				config.MODEL_TOKEN_CAPS.default;

			// Get the total tokens used so far
			const currentModelData = modelData[currentlyDisplayedModel];
			const modelTotal = currentModelData?.total || 0;

			// Calculate how many tokens are left
			const remainingTokens = maxTokens - modelTotal;
			debugLog(`Calculating difference: ${maxTokens} - ${modelTotal} = ${remainingTokens}`)
			debugLog("Estimating messages...")


			let estimate;
			if (conversationLength > 0 && currentlyDisplayedModel != "default") {
				// Divide remaining by avg length, ensure not negative
				estimate = Math.max(0, remainingTokens / conversationLength);
				// Round to 1 decimal place
				estimate = estimate.toFixed(1);
			} else {
				estimate = "N/A";
			}
			debugLog("Estimate", estimate)
			estimateDisplay.textContent = `Est. messages left: ${estimate}`;
		}

		// Update each model section
		debugLog("Updating model sections...")
		config.MODELS.forEach(modelName => {
			const modelInfo = modelData[modelName] || {};
			const modelTotal = modelInfo.total || 0;
			const messageCount = modelInfo.messageCount || 0;
			const maxTokens = config.MODEL_TOKEN_CAPS[modelName] || config.MODEL_TOKEN_CAPS.default;
			const percentage = (modelTotal / maxTokens) * 100;
			const section = modelSections[modelName];
			if (!section) {
				console.warn(`Section for model ${modelName} not found`);
				return;
			};
			section.progressBar.style.width = `${Math.min(percentage, 100)}%`;
			section.progressBar.style.background = modelTotal >= maxTokens * config.WARNING_THRESHOLD ? '#ef4444' : '#3b82f6';
			section.tooltip.textContent = `${modelTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;
			section.messageCounter.textContent = `Messages: ${messageCount}`;

			const resetTime = modelInfo.resetTimestamp ?
				formatTimeRemaining(new Date(modelInfo.resetTimestamp)) :
				'Reset in: Not set';
			section.resetTimeDisplay.textContent = resetTime;
		});
	}

	function formatTimeRemaining(resetTime) {
		const now = new Date();
		const diff = resetTime - now;

		if (diff <= 0) return 'Reset pending...';
		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		return hours > 0 ? `Reset in: ${hours}h ${minutes}m` : `Reset in: ${minutes}m`;
	}

	// Listen for messages from background
	browser.runtime.onMessage.addListener(async (message) => {
		if (message.type === 'updateUsage') {
			updateProgressBar(message.data);
		}

		if (message.type === 'getActiveModel') {
			return await getCurrentModel();
		}

		if (message.action === "getOrgID") {
			const orgId = document.cookie
				.split('; ')
				.find(row => row.startsWith('lastActiveOrg='))
				?.split('=')[1];
			return Promise.resolve({ orgId });
		}
	});
	//#endregion

	//#region Event Handlers
	function pollForModelChange() {
		setInterval(async () => {
			const newModel = await getCurrentModel();
			const isHomePage = getConversationId() === null;
			const newConversation = getConversationId();
			// Check for model or conversation change
			if (currentConversation !== newConversation && !isHomePage) {
				debugLog(`Conversation changed from ${currentConversation} to ${newConversation}`);
				await updateProgressBar(await sendBackgroundMessage({ type: 'requestData', conversationId: newConversation }));
				currentConversation = newConversation;
			}

			if (newModel !== currentlyDisplayedModel) {
				debugLog(`Model changed from ${currentlyDisplayedModel} to ${newModel}`);
			}

			debugLog("Updating current model...")
			currentlyDisplayedModel = newModel;

			// Update all sections - will collapse inactive ones
			config.MODELS.forEach(async modelName => {
				const section = modelSections[modelName];
				if (section) {
					const isActiveModel = modelName === currentlyDisplayedModel;
					section.setActive(isActiveModel, isHomePage);
				}
			});

			currentConversation = newConversation;

			if (isHomePage) {
				// Reset conversation length display
				const estimateDisplay = document.getElementById('messages-left-estimate');
				estimateDisplay.textContent = `Est. messages left: N/A`;
				const lengthDisplay = document.getElementById('conversation-token-count');
				lengthDisplay.textContent = `Current cost: N/A tokens`;
			}

		}, config.UI_UPDATE_INTERVAL_MS);
	}

	//#endregion
	async function initialize() {
		const MAX_RETRIES = 15;
		const RETRY_DELAY = 200;
		const LOGIN_CHECK_DELAY = 10000;

		// Load and assign configuration to global variables
		debugLog("Calling browser message...")
		config = await sendBackgroundMessage({ type: 'getConfig' });
		debugLog("Config received...")
		debugLog(config)
		let userMenuButton = null;
		while (true) {
			// Check for duplicate running with retry logic

			let attempts = 0;

			while (!userMenuButton && attempts < MAX_RETRIES) {
				userMenuButton = document.querySelector(config.SELECTORS.USER_MENU_BUTTON);
				if (!userMenuButton) {
					debugLog(`User menu button not found, attempt ${attempts + 1}/${MAX_RETRIES}`);
					await sleep(RETRY_DELAY);
					attempts++;
				}
			}

			if (userMenuButton) {
				// Found the button, continue with initialization
				break;
			}

			// Check if we're on either login screen
			const initialLoginScreen = document.querySelector('button[data-testid="login-with-google"]');
			const verificationLoginScreen = document.querySelector('input[data-testid="code"]');

			if (!initialLoginScreen && !verificationLoginScreen) {
				console.error('Neither user menu button nor any login screen found');
				return;
			}

			debugLog('Login screen detected, waiting before retry...');
			await sleep(LOGIN_CHECK_DELAY);
		}



		if (userMenuButton.getAttribute('data-script-loaded')) {
			debugLog('Script already running, stopping duplicate');
			return;
		}
		userMenuButton.setAttribute('data-script-loaded', true);
		debugLog('We\'re unique, initializing Chat Token Counter...');

		storageInterface = new TokenStorageInterface();
		// Initialize everything else
		currentlyDisplayedModel = await getCurrentModel();

		await initUI();
		pollForModelChange();

		await updateProgressBar(await sendBackgroundMessage({ type: 'requestData' }));
		await sendBackgroundMessage({ type: 'initOrg' });
		debugLog('Initialization complete. Ready to track tokens.');
	}

	(async () => {
		try {
			await initialize();
		} catch (error) {
			console.error('Failed to initialize Chat Token Counter:', error);
		}
	})();
})();
