require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');
const { Parser } = require('json2csv');
const { log } = require('console');

const GRANT_TYPE = 'password';
const HOST = '<<host>>';
const API_KEY = '<<api-key>>';
const CLIENT_ID = 'direct-grant';
const CLIENT_SECRET = '<<client-secret>>';
const CHANNEL_ID = '<<channel-id>>';
const CREATOR_USERNAME = '<<creator-username>>';
const CREATOR_PASSWORD = '<<creator-password>>';

const outputRows = [];
const OUTPUT_FILE = 'output_report.csv';

async function getKeycloakToken(username, password) {
  const url = `${HOST}/auth/realms/sunbird/protocol/openid-connect/token`;
  const params = new URLSearchParams();
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('grant_type', GRANT_TYPE);
  params.append('username', username);
  params.append('password', password);

  const res = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${API_KEY}`,
    }
  });
  return res.data;
}

async function refreshAccessToken(refreshToken) {
  const url = `${HOST}/auth/v1/refresh/token`;
  const params = new URLSearchParams();
  params.append('refresh_token', refreshToken);

  const res = await axios.post(url, params, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  });

  return res.data.result;
}

async function getUserId(email, userAccessToken) {
  const url = `${HOST}/api/user/v1/search`;
  const payload = { request: { filters: { email } } };

  const res = await axios.post(url, payload, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'x-authenticated-user-token': userAccessToken,
      'Content-Type': 'application/json',
    }
  });

  const users = res.data.result.response.content;
  if (!users || users.length === 0) throw new Error(`User not found for email ${email}`);
  return users[0].id;
}

async function getCourseAndBatch(courseCode, creatorAccessToken, userToken) {
  const url = `${HOST}/api/composite/v1/search`;
  const payload = { request: { filters: { code: courseCode } } };
  const res = await axios.post(url, payload, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Channel-Id': CHANNEL_ID,
      'Authorization': `Bearer ${API_KEY}`,
      'x-authenticated-user-token': userToken,
    }
  });
  
  const courses = res.data.result.content;
  
  if (!courses || courses.length === 0) throw new Error(`Course not found: ${courseCode}`);
  
  const courseIdWithBatches = [];
  for(const c of courses)
  {
      const courseId = c.identifier;
      for(const b of c.batches)
      {
        const batchId = b.batchId;
        courseIdWithBatches.push({courseId, batchId});
      }
  }
  return courseIdWithBatches;
}

async function getContentIds(courseId, creatorAccessToken) {
  const url = `${HOST}/api/collection/v1/hierarchy/${courseId}`;
  const res = await axios.get(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'x-authenticated-user-token': creatorAccessToken,
    }
  });

  const traverse = (node, arr = []) => {
    if (node.contentType && node.contentType !== 'Course') {
      arr.push(node.identifier);
    }
    if (node.children) {
      node.children.forEach(child => traverse(child, arr));
    }
    return arr;
  };

  return traverse(res.data.result.content);
}

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (num, size = 2) => num.toString().padStart(size, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  const milliseconds = pad(now.getMilliseconds(), 3);
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMins = pad(absOffset % 60);
  const timezone = `${sign}${offsetHours}${offsetMins}`;
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}:${milliseconds}${timezone}`;
}

async function unenrolCourse(userId, batchId, courseId, userAccessToken) 
{
  const url = `${HOST}/api/course/v1/unenrol`;
  const payload = {
    request: {
      courseId,
      batchId,
      userId
    }
  };

  const status = 'failure';
  const msg = '';
  try {
    const res = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'x-authenticated-user-token': userAccessToken,
      }
    });
    console.log("success res : " + JSON.stringify(res.data));
    if(res.data?.params?.status === 'success')
    {
      return {status:'success', msg};
    }
    else
    {
      return {status, msg:res.data?.params?.errmsg};
    }
 } 
 catch(error) 
 {
    if (error.response) {
    const errData = error.response.data;
    if (errData?.params?.err === 'USER_NOT_ENROLLED_COURSE') {
      console.warn('User is not enrolled in the given course batch.');
      return {status, msg:'User is not enrolled in the given course batch.'};
    } else {
      console.error('API Error:', errData?.params?.errmsg || 'Unknown error');
      return {status, msg: errData?.params?.errmsg || 'Unknown error'};
    }

  } else {
    console.error('Unexpected Error:', error.message);
    return {status, msg:error.message};
  }
 }

}

// Main execution
(async () => {
  try {
    const creatorTokenResp = await getKeycloakToken(CREATOR_USERNAME, CREATOR_PASSWORD);
    const creatorAccess = await refreshAccessToken(creatorTokenResp.refresh_token);
    console.log('Creator Access Token acquired');

    const allRows = [];

    fs.createReadStream('input.csv')
      .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
      .on('data', (row) => {
        allRows.push(row);
      })
      .on('end', async () => {
        for (const row of allRows) {
          const email = row.email.trim();
          const password = '';
          const codes = row.course_code.split(',').map(c => c.trim().replace(/"/g, ''));

          //comming from CSV
          let userId = null;
          let batchId = null;
          let courseId = null;
          
          console.log(`Processing: ${email}`);

          for (const code of codes) {
            try 
            {
              const userTokenResp = await getKeycloakToken(email, password);
              const userAccess = await refreshAccessToken(userTokenResp.refresh_token);
              console.log("userAccess token : " + JSON.stringify(userAccess));
              try 
              {
                userId = await getUserId(email, userAccess.access_token);
                
                const courseIdWithBatches = await getCourseAndBatch(code, creatorAccess.access_token, userAccess.access_token);
                
                //courseId = courseIdAndBatchId.courseId;
                //batchId = courseIdAndBatchId.batchId;
                
                for(const cb of courseIdWithBatches) 
                {
                  const batchId = cb.batchId;
                  const courseId = cb.courseId;
                  const {status, msg} = await unenrolCourse(userId, batchId, courseId, userAccess.access_token);

                  outputRows.push({
                    email,
                    userId,
                    batchId,
                    courseId,
                    status: status,
                    remark: msg
                  });

                }
                
              } catch (err) {
                const errMsg = err?.response?.data?.params?.errmsg || err.message;
                console.log(errMsg);
                outputRows.push({
                  email,
                  userId,
                  batchId,
                  courseId,
                  status: 'failure',
                  remark: errMsg
                });
              }
            } catch (err) {
              outputRows.push({
                email,
                userId,
                batchId,
                courseId,
                status: 'failure',
                remark: err.message
              });
            }

          }
        }

        const fields = ['email', 'userId', 'batchId', 'courseId', 'status', 'remark'];
        const json2csvParser = new Parser({ fields });
        const csvData = json2csvParser.parse(outputRows);

        fs.writeFileSync(OUTPUT_FILE, csvData);
        console.log(`✅ Output report saved to ${OUTPUT_FILE}`);
      });

  } catch (err) {
    console.error('Initialization error:', err.message);
  }
})();
