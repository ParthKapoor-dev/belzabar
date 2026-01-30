This is a new idea for finding different methods easily. 

the following api call is used to get all service-categories that exist in the AD: 

curl 'https://nsm-dev.nc.verifi.dev/rest/api/automation/services?limit=2000^&offset=0' \
  --compressed \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Language: en-US,en;q=0.5' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'Referer: https://nsm-dev.nc.verifi.dev/automation-designer' \
  -H 'Content-Type: application/json' \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3Njk3NDk3MTUsImlhdCI6MTc2OTY2MzMxNSwiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZmJlMTZhMDctMTY4My00YTk2LTgxOGEtNDI3NjExNzE3YzkzIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUkVGUkVTSF9UT0tFTiIsInByZWZlcnJlZF91c2VybmFtZSI6InJ1cGluQHdlYmludGVuc2l2ZS5jb20iLCJhcHBsaWNhdGlvbklkIjoiMzJkODViOGEtZTliNC00MWU1LWEzNmYtMjQ1MzAxZWY5ZDBmIiwicm9sZXMiOltdfQ.Q1mI1aCorZfWnKkR92xlpCb0QbX8V7nNzsGQClPLWdeyG-fFIEz8Y47EBkBnpM-tIocRwhDxTV0hRaot_zTF3hnq_raVCe8YGMxtSDXODOJk8bRb3EHnzMZXN2keifw-JfJaURfKEvJ4pVHnhaSPl57Gy-8YaR4lijbhNTPCjxOzQTpWSB4bYggqLRTU_OZ8l4unHg6KxShsEAoLC2yVy20TtYem4Jp0-8NTsrl4jfFi9Vb5hVB_odSNVL940batJQOs480zmifTNz8PL9SUnJ06WQeQpIOpYkl6sUHkHTXtzi29OBT2Jt5qfK3VsGTkcjTeDmkVh09d_gboFFaYfQ' \
  -H 'Sec-GPC: 1' \
  -H 'Connection: keep-alive' \
  -H 'Cookie: _ga_12CXZ03BZT=GS2.1.s1769674489$o13$g1$t1769676713$j60$l0$h0; _ga=GA1.2.45726920.1767939145; _gid=GA1.2.2106237836.1769490710; _gat_gtag_UA_148064033_1=1' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'TE: trailers'

The Response: 
currentOffset	105,
result:[
{
	"74": {
		"id": 53,
		"name": "NSM.Documents",
		"aliasName": [
			"NSM.Documents"
		],
		"originalLabel": "NSM.Documents",
		"description": "",
		"authorizationFields": [],
		"automationAuths": [],
		"owner": {
			"uuid": "d80e0697-9804-4dd9-ac78-5d55b7c688ca",
			"id": 1552,
			"externalUuid": "d80e0697-9804-4dd9-ac78-5d55b7c688ca",
			"email": "bhavesh@webintensive.com",
			"firstName": "Bhaveshh",
			"lastName": "Kaushik",
			"ssoUser": false,
			"boss": {
				"id": 5,
				"email": "rahulkt@TrueVeeGeeDee.com",
				"firstName": "Admin",
				"lastName": "User",
				"ssoUser": false,
				"boss": {
					"id": 2,
					"ssoUser": false,
					"mfaEnabled": false
				},
				"mfaEnabled": false,
				"fullName": "Admin User",
				"title": "Admin User"
			},
			"userLocale": {
				"id": 1,
				"name": "en_US",
				"description": "English (US)",
				"active": false,
				"createdAt": null
			},
			"joiningDate": 1733982904416,
			"mfaEnabled": false,
			"fullName": "Bhaveshh Kaushik",
			"lastLoginDate": 1753872462416,
			"title": "Bhaveshh Kaushik"
		},
		"accessMode": "PUBLIC",
		"permissionSet": [],
		"securityTags": [
			"ALLOW_PORTAL_USER"
		],
		"type": "USER_GENERATED",
		"uuid": "403c868c260221961bb19a821139f1d6",
		"automationSystemUuid": "4719d6f948fbc6877889a28e8ce33e6f",
		"migration": false,
		"active": true,
		"label": "NSM.Documents",
		"authOptional": false,
		"externalIntegration": false,
		"permissions": [],
		"allowedActions": [],
		"remote": false,
		"securityTagsCommaSeparated": "ALLOW_PORTAL_USER",
		"isAuthenticationStructureInherited": false
	}
},
{
	"75": {
		"id": 76,
		"name": "NSM.FPA",
		"aliasName": [
			""
		],
		"originalLabel": "NSM.FPA",
		"description": "",
		"authorizationFields": [],
		"automationAuths": [],
		"owner": {
			"uuid": "93d7b09f-6562-4c9a-bac3-3a6bf81054ee",
			"id": 15,
			"externalUuid": "93d7b09f-6562-4c9a-bac3-3a6bf81054ee",
			"email": "rupin@webintensive.com",
			"firstName": "Rupinnnn",
			"lastName": "Vijan",
			"ssoUser": false,
			"boss": {
				"id": 7,
				"email": "madhav@temp.com",
				"firstName": "Madhav",
				"lastName": "Chahar",
				"ssoUser": false,
				"boss": {
					"id": 5,
					"ssoUser": false,
					"mfaEnabled": false
				},
				"mfaEnabled": false,
				"fullName": "Madhav Chahar",
				"title": "Madhav Chahar"
			},
			"userLocale": {
				"id": 1,
				"name": "en_US",
				"description": "English (US)",
				"active": false,
				"createdAt": null
			},
			"joiningDate": 1693298567945,
			"mfaEnabled": false,
			"fullName": "Rupinnnn Vijan",
			"lastLoginDate": 1769663553140,
			"title": "Rupinnnn Vijan"
		},
		"accessMode": "PUBLIC",
		"permissionSet": [],
		"securityTags": [
			"ALLOW_PORTAL_USER"
		],
		"type": "USER_GENERATED",
		"uuid": "4e53055bade6e14259f195eee2684daf",
		"automationSystemUuid": "4ed462d3c96711dc0ad08033d278b119",
		"migration": false,
		"active": true,
		"label": "NSM.FPA",
		"authOptional": false,
		"externalIntegration": false,
		"permissions": [],
		"allowedActions": [],
		"remote": false,
		"securityTagsCommaSeparated": "ALLOW_PORTAL_USER",
		"isAuthenticationStructureInherited": false
	}
}......
]

NOTE: Only 2 of the service-categories were provided to you. but in the actual response all the 105 methods were given.

Following is the api to is used to get all the methods inside a particular service category 

curl 'https://nsm-dev.nc.verifi.dev/rest/api/automation/methods?categoryUuid=460b1b91eeded4f733deba1ba6427702^&limit=100^&offset=0' \
  --compressed \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Language: en-US,en;q=0.5' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'Referer: https://nsm-dev.nc.verifi.dev/automation-designer' \
  -H 'Content-Type: application/json' \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3Njk3NDk3MTUsImlhdCI6MTc2OTY2MzMxNSwiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZmJlMTZhMDctMTY4My00YTk2LTgxOGEtNDI3NjExNzE3YzkzIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUkVGUkVTSF9UT0tFTiIsInByZWZlcnJlZF91c2VybmFtZSI6InJ1cGluQHdlYmludGVuc2l2ZS5jb20iLCJhcHBsaWNhdGlvbklkIjoiMzJkODViOGEtZTliNC00MWU1LWEzNmYtMjQ1MzAxZWY5ZDBmIiwicm9sZXMiOltdfQ.Q1mI1aCorZfWnKkR92xlpCb0QbX8V7nNzsGQClPLWdeyG-fFIEz8Y47EBkBnpM-tIocRwhDxTV0hRaot_zTF3hnq_raVCe8YGMxtSDXODOJk8bRb3EHnzMZXN2keifw-JfJaURfKEvJ4pVHnhaSPl57Gy-8YaR4lijbhNTPCjxOzQTpWSB4bYggqLRTU_OZ8l4unHg6KxShsEAoLC2yVy20TtYem4Jp0-8NTsrl4jfFi9Vb5hVB_odSNVL940batJQOs480zmifTNz8PL9SUnJ06WQeQpIOpYkl6sUHkHTXtzi29OBT2Jt5qfK3VsGTkcjTeDmkVh09d_gboFFaYfQ' \
  -H 'Sec-GPC: 1' \
  -H 'Connection: keep-alive' \
  -H 'Cookie: _ga_12CXZ03BZT=GS2.1.s1769674489$o13$g1$t1769676713$j60$l0$h0; _ga=GA1.2.45726920.1767939145; _gid=GA1.2.2106237836.1769490710' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'Priority: u=0' \
  -H 'TE: trailers'

the response: 
currentOffset: 64,
methodList: [
{
	"0": {
		"id": 1550,
		"uuid": "4e55820ce5357ce4c1a4aa378f241f36",
		"jsonDefinition": "{\"name\": \"_lookupDCIN\", \"inputs\": [{\"type\": \"STRING\", \"label\": \"vin\", \"required\": false, \"fieldCode\": \"vin\", \"hideInput\": false, \"orderIndex\": -1, \"properties\": [], \"inputVarRef\": \"\"}], \"outputs\": [{\"id\": 3243, \"code\": \"isVehicleStolenOrNot\", \"type\": \"JSON\", \"fieldCode\": \"isVehicleStolenOrNot\", \"outputCode\": \"isVehicleStolenOrNot\", \"properties\": [], \"displayName\": \"isVehicleStolenOrNot\", \"rawResponseContainer\": false, \"hiddenAutomationAPIOutputIds\": []}], \"summary\": \"\", \"services\": [{\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"isVehicleStolenDetail\", \"properties\": [], \"displayName\": \"isVehicleStolenDetail\", \"automationId\": 23709, \"internalVarRef\": \"isVehicleStolenOrNot\", \"rawResponseContainer\": false, \"automationAPIOutputId\": 492, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"mappings\": [{\"value\": \"{\\n    \\\"1HGFA16506L123456\\\": {\\n        \\\"is_stolen\\\": \\\"false\\\"\\n    },\\n\\\"HGCM82633A004352\\\": {\\\"is_stolen\\\": \\\"true\\\"},\\n\\\"4T1BF1FK5GU235678\\\" : {\\\"is_stolen\\\": \\\"true\\\"},\\n    \\\"1C4PJMDX0KD123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"JH4KA9650MC123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"2FTRX18W1XCA12345\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"3N1AB7AP7KY123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"1GNEK13ZX3R123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"4T1BF28B6YU123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"5FNRL38798B123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"1J4GA59178L123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"1G1ZC5E17AF123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"2HGFB2F50CH123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"3VWDP7AJ5DM123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"1N4AL3AP4FC123456\\\": {\\n        \\\"is_stolen\\\": true\\n    },\\n    \\\"JN8AS5MV0CW123456\\\": {\\n        \\\"is_stolen\\\": false\\n    },\\n    \\\"4S4BRBCC7D3212345\\\": {\\n        \\\"is_stolen\\\": true\\n    }\\n}\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1721, \"automationUserInputUuid\": \"485f005348ad45146ad3a8b3157f3fbf    \"}, {\"value\": \"$..#{vin}\\n\\n\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1722, \"automationUserInputUuid\": \"42c18030bc54dde099a5bbaa899eb7e7    \"}], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"OBJECT\", \"requiresProcessing\": true, \"skipFileProcessing\": true, \"automationUserInputId\": 1720, \"automationUserInputUuid\": \"441c37ac1fde9d05e50596e1b3775a9f    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"condition\": [], \"forceExist\": false, \"orderIndex\": 1, \"automationId\": 23709, \"conditionMode\": \"advance\", \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"conditionExpression\": \"false\", \"repeatStepExecution\": false, \"forceExitFromFailure\": false, \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}, {\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"result\", \"properties\": [], \"displayName\": \"result\", \"automationId\": 23710, \"rawResponseContainer\": false, \"automationAPIOutputId\": 96, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"mappings\": [{\"value\": \"SELECT CASE\\n        WHEN #{QUOTE.SQL:vin} ILIKE 'OLS%' THEN '{\\\"is_stolen\\\" : true}'\\n        WHEN #{QUOTE.SQL:vin} ILIKE 'NOLS%' THEN '{\\\"is_stolen\\\" : true}'\\n        ELSE '{\\\"is_stolen\\\" : false}'\\n    END AS result;\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 183, \"automationUserInputUuid\": \"4507050db7c36bf6d5659ce40090f5b5    \"}], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"OBJECT\", \"requiresProcessing\": true, \"skipFileProcessing\": true, \"automationUserInputId\": 182, \"automationUserInputUuid\": \"4f9c985d8a5d067a3b279d9fc74d4fe5    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"forceExist\": false, \"orderIndex\": 2, \"description\": \"condition<ul><li>OLS - Owner and Lienholder and Stolen</li><li>NOLS - No Owner and Lienholder and Stolen</li><li>NOLNS - No Owner and Lienholder and Not Stolen</li><li>Else - Owner and Lienholder and not Stolen</li></ul>\", \"automationId\": 23710, \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"repeatStepExecution\": false, \"forceExitFromFailure\": true, \"forceExitErrorMessage\": \"\", \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}, {\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"vehicleStolen\", \"properties\": [], \"displayName\": \"vehicleStolen\", \"automationId\": 23711, \"internalVarRef\": \"isVehicleStolenOrNot\", \"rawResponseContainer\": false, \"automationAPIOutputId\": 480, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"value\": \"[#{result[0].result}]\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1651, \"automationUserInputUuid\": \"44755c8e6270645dae4a9297a48d0061    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"forceExist\": false, \"orderIndex\": 3, \"automationId\": 23711, \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"repeatStepExecution\": false, \"forceExitFromFailure\": true, \"forceExitErrorMessage\": \"\", \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}], \"variables\": [{\"type\": \"JSON\", \"label\": \"isVehicleStolenOrNot\", \"required\": false, \"fieldCode\": \"isVehicleStolenOrNot\", \"hideInput\": false, \"orderIndex\": -1, \"properties\": [], \"inputVarRef\": \"\"}], \"assertions\": [], \"buttonLabel\": \"\", \"internalMethod\": false, \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"failingSteps\": [], \"executionTime\": {}, \"failingStepsStatuses\": []}, \"methodDescription\": \"Author: Bhavesh, Rupin\\nDate: 17-09-2024\\nVersion: 1.2\\nSummary: We will lookup vin using NMVTIS with condition as \\nOLS - Owner and Lienholder and Stolen\\nNOLS - No Owner and Lienholder and Stolen\\nNOLNS - No Owner and Lienholder and Not Stolen\\nElse - Owner and Lienholder and not Stolen\\nTW: 25081060\", \"useServiceAuthenticationStructure\": false}",
		"version": 1,
		"aliasName": "staff.fetch.dcinDetails",
		"methodDescription": "Author: Bhavesh, Rupin\nDate: 17-09-2024\nVersion: 1.2\nSummary: We will lookup vin using NMVTIS with condition as \nOLS - Owner and Lienholder and Stolen\nNOLS - No Owner and Lienholder and Stolen\nNOLNS - No Owner and Lienholder and Not Stolen\nElse - Owner and Lienholder and not Stolen\nTW: 25081060",
		"changelog": [],
		"sourceRefId": "4bac5a7ea357cc8376e998df1baa432c",
		"sourceRefType": "AD",
		"permissions": [
			{
				"id": 20318,
				"automationChainDefinitionId": null,
				"permissionType": "ALLOW_ALL_INTERNAL_USERS",
				"groups": [],
				"users": [
					{
						"id": 131,
						"email": "vivek.yadav@webintensive.com",
						"firstName": "Vivek",
						"lastName": "NSS",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Vivek NSS",
						"title": "Vivek NSS"
					}
				]
			},
			{
				"id": 20319,
				"automationChainDefinitionId": null,
				"permissionType": "ALLOW_USERS_TO_EDIT",
				"groups": [],
				"users": [
					{
						"id": 131,
						"email": "vivek.yadav@webintensive.com",
						"firstName": "Vivek",
						"lastName": "NSS",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Vivek NSS",
						"title": "Vivek NSS"
					},
					{
						"id": 327,
						"email": "rupin+14@webintensive.com",
						"firstName": "Rupinn",
						"lastName": "Vijann",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Rupinn Vijann",
						"title": "Rupinn Vijann"
					},
					{
						"id": 1607,
						"email": "yash.agarwal@webintensive.com",
						"firstName": "Yash",
						"lastName": "Agarwal",
						"blocked": true,
						"ssoUser": false,
						"boss": {
							"id": 9,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Yash Agarwal",
						"title": "Yash Agarwal"
					},
					{
						"id": 1552,
						"email": "bhavesh@webintensive.com",
						"firstName": "Bhaveshh",
						"lastName": "Kaushik",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Bhaveshh Kaushik",
						"title": "Bhaveshh Kaushik"
					},
					{
						"id": 89,
						"email": "rupin5++@webintensive.com",
						"firstName": "rupin",
						"lastName": "vijan",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "rupin vijan",
						"title": "rupin vijan"
					},
					{
						"id": 7,
						"email": "madhav@temp.com",
						"firstName": "Madhav",
						"lastName": "Chahar",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Madhav Chahar",
						"title": "Madhav Chahar"
					},
					{
						"id": 15,
						"email": "rupin@webintensive.com",
						"firstName": "Rupinnnn",
						"lastName": "Vijan",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Rupinnnn Vijan",
						"title": "Rupinnnn Vijan"
					}
				]
			}
		],
		"permissionSet": [
			"EDIT_AUTOMATION_METHOD",
			"USE_AUTOMATION_METHOD_IN_GUIDE",
			"VIEW_AUTOMATION_METHOD",
			"USE_AUTOMATION_METHOD_DIRECTLY"
		],
		"createdBy": 9,
		"createdOn": 1725518318942,
		"updatedBy": 9,
		"updatedOn": 1727241700190,
		"referenceId": "4e97542c0e533cba320497c1b4162aed",
		"state": "PUBLISHED",
		"migrationVersion": 1725518318940,
		"methodDeprecated": false,
		"deprecatedAt": 1727241700176,
		"securityTags": [],
		"migration": false,
		"lastPublishedAt": 1727241700176,
		"lastPublishedBy": 9,
		"methodType": "USER_GENERATED",
		"automationApiUuid": "4d113a2a1b6f7bd92097aad502c4f567",
		"active": false,
		"automationState": "PUBLISHED",
		"securityTagsCommaSeparated": ""
	}
},
{
	"1": {
		"id": 1551,
		"uuid": "4e1df7ec25137e5ed8f7acc23fb7e735",
		"jsonDefinition": "{\"name\": \"_lookupNMVITS\", \"inputs\": [{\"type\": \"STRING\", \"label\": \"vin\", \"required\": false, \"fieldCode\": \"vin\", \"hideInput\": false, \"orderIndex\": -1, \"properties\": [], \"inputVarRef\": \"\"}], \"outputs\": [{\"id\": 3333, \"code\": \"ownerFoundInStar\", \"type\": \"JSON\", \"fieldCode\": \"ownerFoundInStar\", \"outputCode\": \"ownerFoundInStar\", \"properties\": [], \"displayName\": \"ownerFoundInStar\", \"automationId\": 24643, \"rawResponseContainer\": false, \"automationAPIOutputId\": 480, \"hiddenAutomationAPIOutputIds\": []}], \"summary\": \"\", \"services\": [{\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"ownerFoundInStarsNotValid\", \"properties\": [], \"displayName\": \"ownerFoundInStarsNotValid\", \"automationId\": 24641, \"rawResponseContainer\": false, \"automationAPIOutputId\": 492, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"mappings\": [{\"value\": \"{\\n\\\"32145K\\\": {\\n\\\"plate\\\": \\\"8MNB789\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"Fiesta SE\\\",\\n        \\\"body_style\\\": \\\"Hatchback\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n},\\n    \\\"3FADP4BJ7EM172735\\\": {\\n        \\\"plate\\\": \\\"8MNB789\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"Fiesta SE\\\",\\n        \\\"body_style\\\": \\\"Hatchback\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"scfkwx12414vvpb\\\": {\\n        \\\"plate\\\": \\\"46VMD3535\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Lambo\\\",\\n        \\\"model\\\": \\\"La Fer\\\",\\n        \\\"body_style\\\": \\\"MNM\\\",\\n        \\\"state_registered\\\": \\\"CAL\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Louis Farms\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"2FTRX18W5XCA56789\\\": {\\n        \\\"plate\\\": \\\"46VMD3535\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ford Mustang\\\",\\n        \\\"model\\\": \\\"La Fer\\\",\\n        \\\"body_style\\\": \\\"Nontuer\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Louis Farms\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"1C6RR7LT2ES123456\\\": {\\n        \\\"plate\\\": \\\"3NMJ456\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ram\\\",\\n        \\\"model\\\": \\\"1500 Laramie\\\",\\n        \\\"body_style\\\": \\\"Truck\\\",\\n        \\\"state_registered\\\": \\\"FL\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"PNC Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"FL\\\"\\n    },\\n    \\\"1HGCM82633A004352\\\": {\\n        \\\"plate\\\": \\\"7JHU123\\\",\\n        \\\"year\\\": \\\"2003\\\",\\n        \\\"make\\\": \\\"Honda\\\",\\n        \\\"model\\\": \\\"Accord EX\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"CA\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Bank of America\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"CA\\\"\\n    },\\n    \\\"2HGFB2F57CH123456\\\": {\\n        \\\"plate\\\": \\\"8UYT789\\\",\\n        \\\"year\\\": \\\"2012\\\",\\n        \\\"make\\\": \\\"Honda\\\",\\n        \\\"model\\\": \\\"Civic LX\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"AZ\\\",\\n        \\\"year_registered\\\": \\\"2021\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Toyota Financial Services\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"AZ\\\"\\n    },\\n    \\\"1FTFW1CF4EFB12345\\\": {\\n        \\\"plate\\\": \\\"9VWX456\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"F-150 XL\\\",\\n        \\\"body_style\\\": \\\"Truck\\\",\\n        \\\"state_registered\\\": \\\"GA\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"GM Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"GA\\\"\\n    },\\n    \\\"5TFEY5F12EX123456\\\": {\\n        \\\"plate\\\": \\\"7OPQ123\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Toyota\\\",\\n        \\\"model\\\": \\\"Tundra SR5\\\",\\n        \\\"body_style\\\": \\\"Truck\\\",\\n        \\\"state_registered\\\": \\\"AZ\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"AZ\\\"\\n    },\\n    \\\"1N4AL3AP9DN449712\\\": {\\n        \\\"plate\\\": \\\"6GHJ789\\\",\\n        \\\"year\\\": \\\"2013\\\",\\n        \\\"make\\\": \\\"Nissan\\\",\\n        \\\"model\\\": \\\"Altima S\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"NC\\\",\\n        \\\"year_registered\\\": \\\"2021\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"SunTrust Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NC\\\"\\n    },\\n    \\\"5UXWX7C53E0F12345\\\": {\\n        \\\"plate\\\": \\\"1ABC234\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"BMW\\\",\\n        \\\"model\\\": \\\"X3 xDrive28i\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"IL\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Ally Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"IL\\\"\\n    },\\n    \\\"1GCGSCE31F1234567\\\": {\\n        \\\"plate\\\": \\\"9LMN123\\\",\\n        \\\"year\\\": \\\"2015\\\",\\n        \\\"make\\\": \\\"Chevrolet\\\",\\n        \\\"model\\\": \\\"Colorado LT\\\",\\n        \\\"body_style\\\": \\\"Truck\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"GM Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"5J6RM4H77DL123456\\\": {\\n        \\\"plate\\\": \\\"7QAZ456\\\",\\n        \\\"year\\\": \\\"2013\\\",\\n        \\\"make\\\": \\\"Honda\\\",\\n        \\\"model\\\": \\\"CR-V EX\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"FL\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"BBVA Compass\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"FL\\\"\\n    },\\n    \\\"1FTFW1ET1DFA23456\\\": {\\n        \\\"plate\\\": \\\"6MNB123\\\",\\n        \\\"year\\\": \\\"2013\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"F-150 Platinum\\\",\\n        \\\"body_style\\\": \\\"Truck\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"Yes\\\",\\n        \\\"lien_holder\\\": \\\"Chase Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"1HGCM82633A056789\\\": {\\n        \\\"plate\\\": \\\"4PLK789\\\",\\n        \\\"year\\\": \\\"2003\\\",\\n        \\\"make\\\": \\\"Honda\\\",\\n        \\\"model\\\": \\\"Accord LX\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"CA\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Bank of America\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"CA\\\"\\n    },\\n    \\\"1G1PE5SB3E7123456\\\": {\\n        \\\"plate\\\": \\\"3BVN678\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Chevrolet\\\",\\n        \\\"model\\\": \\\"Cruze LS\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"NV\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Ally Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NV\\\"\\n    },\\n    \\\"2C4RDGCG4ER123456\\\": {\\n        \\\"plate\\\": \\\"6UVW789\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Dodge\\\",\\n        \\\"model\\\": \\\"Grand Caravan SE\\\",\\n        \\\"body_style\\\": \\\"Minivan\\\",\\n        \\\"state_registered\\\": \\\"MI\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Chase Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"MI\\\"\\n    },\\n    \\\"5TDZK23C07S129430\\\": {\\n        \\\"plate\\\": \\\"3PLC234\\\",\\n        \\\"year\\\": \\\"2007\\\",\\n        \\\"make\\\": \\\"Toyota\\\",\\n        \\\"model\\\": \\\"Sienna LE\\\",\\n        \\\"body_style\\\": \\\"Minivan\\\",\\n        \\\"state_registered\\\": \\\"NY\\\",\\n        \\\"year_registered\\\": \\\"2020\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"Yes\\\",\\n        \\\"lien_holder\\\": \\\"PNC Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NY\\\"\\n    },\\n    \\\"WVWBN7AN4EE503456\\\": {\\n        \\\"plate\\\": \\\"8RTY234\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Volkswagen\\\",\\n        \\\"model\\\": \\\"CC Sport\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"VA\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Ally Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"VA\\\"\\n    },\\n    \\\"3C4PDCGG0HT123456\\\": {\\n        \\\"plate\\\": \\\"4FGH567\\\",\\n        \\\"year\\\": \\\"2017\\\",\\n        \\\"make\\\": \\\"Dodge\\\",\\n        \\\"model\\\": \\\"Journey GT\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"CO\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"BBVA Compass\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"CO\\\"\\n    },\\n    \\\"5FNRL5H92EB123456\\\": {\\n        \\\"plate\\\": \\\"5HJY234\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Honda\\\",\\n        \\\"model\\\": \\\"Odyssey Touring\\\",\\n        \\\"body_style\\\": \\\"Minivan\\\",\\n        \\\"state_registered\\\": \\\"CA\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"Yes\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"CA\\\"\\n    },\\n    \\\"1C4RJFBG8FC012345\\\": {\\n        \\\"plate\\\": \\\"2XCV456\\\",\\n        \\\"year\\\": \\\"2015\\\",\\n        \\\"make\\\": \\\"Jeep\\\",\\n        \\\"model\\\": \\\"Grand Cherokee Limited\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"NJ\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"SunTrust Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NJ\\\"\\n    },\\n    \\\"WAUFFAFL1CN123456\\\": {\\n        \\\"plate\\\": \\\"2QAZ678\\\",\\n        \\\"year\\\": \\\"2012\\\",\\n        \\\"make\\\": \\\"Audi\\\",\\n        \\\"model\\\": \\\"A4 Premium\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"NY\\\",\\n        \\\"year_registered\\\": \\\"2021\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"PNC Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NY\\\"\\n    },\\n    \\\"4S3BMBC64E1234567\\\": {\\n        \\\"plate\\\": \\\"7HJK345\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Subaru\\\",\\n        \\\"model\\\": \\\"Legacy 2.5i Premium\\\",\\n        \\\"body_style\\\": \\\"Sedan\\\",\\n        \\\"state_registered\\\": \\\"WA\\\",\\n        \\\"year_registered\\\": \\\"2023\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"WA\\\"\\n    },\\n    \\\"1GNSCBE09CR123456\\\": {\\n        \\\"plate\\\": \\\"6TYU345\\\",\\n        \\\"year\\\": \\\"2012\\\",\\n        \\\"make\\\": \\\"Chevrolet\\\",\\n        \\\"model\\\": \\\"Suburban LT\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"GM Financial\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n    },\\n    \\\"2WED3454CN123456\\\": {\\n        \\\"plate\\\": \\\"2WED345\\\",\\n        \\\"year\\\": \\\"2013\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"Escape SE\\\",\\n        \\\"body_style\\\": \\\"SUV\\\",\\n        \\\"state_registered\\\": \\\"NY\\\",\\n        \\\"year_registered\\\": \\\"2021\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"Yes\\\",\\n        \\\"lien_holder\\\": \\\"Chase Bank\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"NY\\\"\\n    }\\n}\\n\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1721, \"automationUserInputUuid\": \"485f005348ad45146ad3a8b3157f3fbf    \"}, {\"value\": \"$..#{vin}\\n\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1722, \"automationUserInputUuid\": \"42c18030bc54dde099a5bbaa899eb7e7    \"}], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"OBJECT\", \"requiresProcessing\": true, \"skipFileProcessing\": true, \"automationUserInputId\": 1720, \"automationUserInputUuid\": \"441c37ac1fde9d05e50596e1b3775a9f    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"condition\": [], \"forceExist\": false, \"orderIndex\": 1, \"automationId\": 24641, \"conditionMode\": \"advance\", \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"conditionExpression\": \"false\", \"repeatStepExecution\": false, \"forceExitFromFailure\": true, \"forceExitErrorMessage\": \"\", \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}, {\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"ownerFoundInStarsResult\", \"properties\": [], \"displayName\": \"ownerFoundInStarsResult\", \"automationId\": 24642, \"rawResponseContainer\": false, \"automationAPIOutputId\": 96, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"mappings\": [{\"value\": \"SELECT CASE\\n        WHEN #{QUOTE.SQL:vin} ILIKE 'NOLNS%' THEN NULL\\n        WHEN #{QUOTE.SQL:vin} ILIKE 'NOLS%' THEN NULL\\n        ELSE '{\\n        \\\"plate\\\": \\\"8MNB789\\\",\\n        \\\"year\\\": \\\"2014\\\",\\n        \\\"make\\\": \\\"Ford\\\",\\n        \\\"model\\\": \\\"Fiesta SE\\\",\\n        \\\"body_style\\\": \\\"Hatchback\\\",\\n        \\\"state_registered\\\": \\\"TX\\\",\\n        \\\"year_registered\\\": \\\"2022\\\",\\n        \\\"stolen\\\": \\\"No\\\",\\n        \\\"purged_theft\\\": \\\"No\\\",\\n        \\\"lien_holder\\\": \\\"Wells Fargo\\\",\\n        \\\"last_known_state_of_titling\\\": \\\"TX\\\"\\n}'\\n    END AS result;\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 183, \"automationUserInputUuid\": \"4507050db7c36bf6d5659ce40090f5b5    \"}], \"withPrefix\": false, \"combineInputs\": false, \"uiRepresentation\": \"OBJECT\", \"requiresProcessing\": true, \"skipFileProcessing\": true, \"automationUserInputId\": 182, \"automationUserInputUuid\": \"4f9c985d8a5d067a3b279d9fc74d4fe5    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"condition\": [], \"forceExist\": false, \"orderIndex\": 2, \"description\": \"Condition for owner details<ul><li>OLS - Owner and Lienholder and Stolen</li><li>NOLS - No Owner and Lienholder and Stolen</li><li>NOLNS - No Owner and Lienholder and Not Stolen</li><li>Else - Owner and Lienholder and not Stolen</li></ul>\", \"automationId\": 24642, \"conditionMode\": \"advance\", \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"conditionExpression\": \"false\", \"repeatStepExecution\": false, \"forceExitFromFailure\": true, \"forceExitErrorMessage\": \"\", \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}, {\"empty\": false, \"inputs\": [], \"outputs\": [{\"code\": \"ownerFoundInStar\", \"properties\": [], \"displayName\": \"ownerFoundInStar\", \"automationId\": 24643, \"rawResponseContainer\": false, \"automationAPIOutputId\": 480, \"hiddenAutomationAPIOutputIds\": []}], \"mappings\": [{\"value\": \"[\\n{\\n  \\\"vehicleInformation\\\": {\\n    \\\"vin\\\": \\\"TPPFXC0UJ3RZ8KJV7\\\",\\n    \\\"make\\\": \\\"Honda\\\",\\n    \\\"model\\\": \\\"Model 3\\\",\\n    \\\"year\\\": 2000,\\n    \\\"bodyType\\\": \\\"BT\\\",\\n    \\\"fuel\\\": \\\"E\\\",\\n    \\\"title\\\": \\\"XJFTSHEASHX736A\\\",\\n    \\\"titleStatus\\\": \\\"ACT\\\",\\n    \\\"actDate\\\": \\\"2022-03-10\\\",\\n    \\\"titleDate\\\": \\\"2022-03-15\\\",\\n    \\\"titleTransferDate\\\": \\\"2022-04-01\\\",\\n    \\\"applicationDate\\\": \\\"2022-02-25\\\",\\n    \\\"printDate\\\": \\\"2022-03-20\\\",\\n    \\\"plateNumber\\\": \\\"4KXP1XA\\\",\\n    \\\"stolenIndicator\\\": \\\"Y\\\"\\n  },\\n  \\\"ownerInformation\\\": [],\\n  \\\"lesseeInformation\\\": [],\\n  \\\"lienInformation\\\": [],\\n    \\\"makeType\\\": [{\\\"code\\\": \\\"FSKR\\\", \\\"description\\\": \\\"FISKER OCEAN\\\"}],\\n  \\\"bodyType\\\": [{\\n    \\\"code\\\": \\\"BT\\\",\\n    \\\"description\\\": \\\"Boat Trailer\\\",\\n    \\\"bodyTypeCode\\\": \\\"BTR\\\",\\n    \\\"descriptionNSMVERIFI\\\": \\\"Boat Trailer\\\"\\n  }]\\n}\\n]\", \"mappings\": [], \"withPrefix\": false, \"combineInputs\": true, \"uiRepresentation\": \"CUSTOM\", \"requiresProcessing\": false, \"skipFileProcessing\": false, \"automationUserInputId\": 1651, \"automationUserInputUuid\": \"44755c8e6270645dae4a9297a48d0061    \"}], \"runAsync\": false, \"activeTab\": {\"id\": \"existingService\"}, \"forceExist\": false, \"orderIndex\": 3, \"automationId\": 24643, \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"executionTime\": {}}, \"repeatStepExecution\": false, \"forceExitFromFailure\": true, \"forceExitErrorMessage\": \"\", \"javascriptNodeJsLambda\": false, \"useServiceAuthenticationStructure\": false}], \"variables\": [], \"assertions\": [], \"buttonLabel\": \"\", \"internalMethod\": false, \"executionStatus\": {\"calls\": [], \"failed\": false, \"executed\": false, \"failingSteps\": [], \"executionTime\": {}, \"failingStepsStatuses\": []}, \"methodDescription\": \"Author: Bhavesh, Rupin\\nDate: 17-09-2024\\nVersion: 1.2\\nSummary: We will lookup vin using NMVTIS with condition as \\nOLS - Owner and Lienholder and Stolen\\nNOLS - No Owner and Lienholder and Stolen\\nNOLNS - No Owner and Lienholder and Not Stolen\\nElse - Owner and Lienholder and not Stolen\\nTW: 25081060\", \"useServiceAuthenticationStructure\": false}",
		"version": 1,
		"aliasName": "staff.fetch.nmvtisDetails",
		"methodDescription": "Author: Bhavesh, Rupin\nDate: 17-09-2024\nVersion: 1.2\nSummary: We will lookup vin using NMVTIS with condition as \nOLS - Owner and Lienholder and Stolen\nNOLS - No Owner and Lienholder and Stolen\nNOLNS - No Owner and Lienholder and Not Stolen\nElse - Owner and Lienholder and not Stolen\nTW: 25081060",
		"changelog": [
			{
				"id": "4cf6f00445979599f9b7b42548db1df5",
				"comment": "Version: 1.2<br id=\"isPasted\">Summary: We will lookup vin using NMVTIS with condition as&nbsp;<br>If VIN starts with C then no owner details<br>Else we will send owner details<br>TW: 25081060",
				"createdAt": 1726558356496
			}
		],
		"sourceRefId": "49318b23669a92a5ec0ea7e336414f6e",
		"sourceRefType": "AD",
		"permissions": [
			{
				"id": 20292,
				"automationChainDefinitionId": null,
				"permissionType": "ALLOW_ALL_INTERNAL_USERS",
				"groups": [],
				"users": [
					{
						"id": 131,
						"email": "vivek.yadav@webintensive.com",
						"firstName": "Vivek",
						"lastName": "NSS",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Vivek NSS",
						"title": "Vivek NSS"
					}
				]
			},
			{
				"id": 20293,
				"automationChainDefinitionId": null,
				"permissionType": "ALLOW_USERS_TO_EDIT",
				"groups": [],
				"users": [
					{
						"id": 131,
						"email": "vivek.yadav@webintensive.com",
						"firstName": "Vivek",
						"lastName": "NSS",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Vivek NSS",
						"title": "Vivek NSS"
					},
					{
						"id": 327,
						"email": "rupin+14@webintensive.com",
						"firstName": "Rupinn",
						"lastName": "Vijann",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Rupinn Vijann",
						"title": "Rupinn Vijann"
					},
					{
						"id": 1607,
						"email": "yash.agarwal@webintensive.com",
						"firstName": "Yash",
						"lastName": "Agarwal",
						"blocked": true,
						"ssoUser": false,
						"boss": {
							"id": 9,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Yash Agarwal",
						"title": "Yash Agarwal"
					},
					{
						"id": 1552,
						"email": "bhavesh@webintensive.com",
						"firstName": "Bhaveshh",
						"lastName": "Kaushik",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Bhaveshh Kaushik",
						"title": "Bhaveshh Kaushik"
					},
					{
						"id": 89,
						"email": "rupin5++@webintensive.com",
						"firstName": "rupin",
						"lastName": "vijan",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "rupin vijan",
						"title": "rupin vijan"
					},
					{
						"id": 7,
						"email": "madhav@temp.com",
						"firstName": "Madhav",
						"lastName": "Chahar",
						"ssoUser": false,
						"boss": {
							"id": 5,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Madhav Chahar",
						"title": "Madhav Chahar"
					},
					{
						"id": 15,
						"email": "rupin@webintensive.com",
						"firstName": "Rupinnnn",
						"lastName": "Vijan",
						"ssoUser": false,
						"boss": {
							"id": 7,
							"ssoUser": false,
							"mfaEnabled": false
						},
						"mfaEnabled": false,
						"fullName": "Rupinnnn Vijan",
						"title": "Rupinnnn Vijan"
					}
				]
			}
		],
		"permissionSet": [
			"EDIT_AUTOMATION_METHOD",
			"USE_AUTOMATION_METHOD_IN_GUIDE",
			"VIEW_AUTOMATION_METHOD",
			"USE_AUTOMATION_METHOD_DIRECTLY"
		],
		"createdBy": 9,
		"createdOn": 1725518326618,
		"updatedBy": 9,
		"updatedOn": 1727970370323,
		"referenceId": "4b3f857e60f905ae480598b5dd2daec3",
		"state": "PUBLISHED",
		"migrationVersion": 1725518326615,
		"methodDeprecated": false,
		"deprecatedAt": 1727970370313,
		"securityTags": [],
		"migration": false,
		"lastPublishedAt": 1727970370313,
		"lastPublishedBy": 9,
		"methodType": "USER_GENERATED",
		"automationApiUuid": "4ef075070caaeb804a80af5f10a902c0",
		"active": false,
		"automationState": "PUBLISHED",
		"securityTagsCommaSeparated": ""
	}
},....
]

The following api is used to search // note: this is used to search from both method and service-categories but the response is only gives the service-categories 
for eg: if a method name is searched, its service category will be returned in the response
for eg: if a service category name is searched, its service category will be returned in the response

curl 'https://nsm-dev.nc.verifi.dev/rest/api/automation/services?query=_view^&limit=2000^&offset=0' \
  --compressed \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Language: en-US,en;q=0.5' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'Referer: https://nsm-dev.nc.verifi.dev/automation-designer' \
  -H 'Content-Type: application/json' \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3Njk3NDk3MTUsImlhdCI6MTc2OTY2MzMxNSwiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZmJlMTZhMDctMTY4My00YTk2LTgxOGEtNDI3NjExNzE3YzkzIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUkVGUkVTSF9UT0tFTiIsInByZWZlcnJlZF91c2VybmFtZSI6InJ1cGluQHdlYmludGVuc2l2ZS5jb20iLCJhcHBsaWNhdGlvbklkIjoiMzJkODViOGEtZTliNC00MWU1LWEzNmYtMjQ1MzAxZWY5ZDBmIiwicm9sZXMiOltdfQ.Q1mI1aCorZfWnKkR92xlpCb0QbX8V7nNzsGQClPLWdeyG-fFIEz8Y47EBkBnpM-tIocRwhDxTV0hRaot_zTF3hnq_raVCe8YGMxtSDXODOJk8bRb3EHnzMZXN2keifw-JfJaURfKEvJ4pVHnhaSPl57Gy-8YaR4lijbhNTPCjxOzQTpWSB4bYggqLRTU_OZ8l4unHg6KxShsEAoLC2yVy20TtYem4Jp0-8NTsrl4jfFi9Vb5hVB_odSNVL940batJQOs480zmifTNz8PL9SUnJ06WQeQpIOpYkl6sUHkHTXtzi29OBT2Jt5qfK3VsGTkcjTeDmkVh09d_gboFFaYfQ' \
  -H 'Sec-GPC: 1' \
  -H 'Connection: keep-alive' \
  -H 'Cookie: _ga_12CXZ03BZT=GS2.1.s1769674489$o13$g1$t1769677197$j9$l0$h0; _ga=GA1.2.45726920.1767939145; _gid=GA1.2.2106237836.1769490710; _gat_gtag_UA_148064033_1=1' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'TE: trailers'

the response: 
{
	"currentOffset": 1,
	"result": [
		{
			"id": 37,
			"name": "NSM.Helpers",
			"aliasName": [
				"NSM-Helpers"
			],
			"originalLabel": "NSM.Helpers",
			"description": "",
			"authorizationFields": [],
			"automationAuths": [],
			"owner": {
				"uuid": "5162005b-b981-4aed-bc54-6ac8c708c822",
				"id": 9,
				"externalUuid": "5162005b-b981-4aed-bc54-6ac8c708c822",
				"email": "rahulg@webintensive.com",
				"firstName": "Rahul ",
				"lastName": "Gupta",
				"ssoUser": false,
				"boss": {
					"id": 5,
					"email": "rahulkt@TrueVeeGeeDee.com",
					"firstName": "Admin",
					"lastName": "User",
					"ssoUser": false,
					"boss": {
						"id": 2,
						"ssoUser": false,
						"mfaEnabled": false
					},
					"mfaEnabled": false,
					"fullName": "Admin User",
					"title": "Admin User"
				},
				"userLocale": {
					"id": 1,
					"name": "en_US",
					"description": "English (US)",
					"active": false,
					"createdAt": null
				},
				"joiningDate": 1689081806017,
				"mfaEnabled": false,
				"fullName": "Rahul  Gupta",
				"lastLoginDate": 1732889043973,
				"title": "Rahul  Gupta"
			},
			"accessMode": "PUBLIC",
			"permissionSet": [],
			"securityTags": [
				"ALLOW_PORTAL_USER"
			],
			"type": "USER_GENERATED",
			"uuid": "460b1b91eeded4f733deba1ba6427702",
			"automationSystemUuid": "4a50356b48424c158020890c82480300",
			"migration": false,
			"active": true,
			"label": "NSM.Helpers",
			"authOptional": false,
			"externalIntegration": false,
			"permissions": [],
			"allowedActions": [],
			"remote": false,
			"securityTagsCommaSeparated": "ALLOW_PORTAL_USER",
			"isAuthenticationStructureInherited": false
		}
	]
}


the aim of method finder is simple, to basically show all available categories etc by default. if I'll search for a method or category name. it will show me its name and i can be able to open it using its id
we will try to cache this data, maybe for a day... so that It can be fetched faster.
